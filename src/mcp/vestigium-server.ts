/**
 * Vestigium logs MCP server (stdio)。
 *
 * 起動: `node dist/mcp/vestigium-server.js`
 * 設定 (Claude Code):
 *   {
 *     "mcpServers": {
 *       "vestigium": {
 *         "command": "node",
 *         "args": ["E:/Document/Ars/Concordia/dist/mcp/vestigium-server.js"]
 *       }
 *     }
 *   }
 *
 * 4 tools:
 *   - vestigium_list_services
 *   - vestigium_tail (alias: 直近 N 行)
 *   - vestigium_search
 *   - vestigium_recent_errors
 *
 * catalog/services.yaml をその場で読み、 log_path がある service だけ対象。
 * Concordia HTTP server とは独立して動く (DB / HTTP / WS 不要)。
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  recent,
  search,
  lastSeenAt,
  type VestigiumRecord,
} from '../observability/log/vestigium-reader.js';

interface ServiceEntry {
  code: string;
  name: string;
  log_path: string;
}

function loadCatalog(catalogPath: string): ServiceEntry[] {
  const raw = readFileSync(catalogPath, 'utf8');
  const parsed = load(raw) as { services?: Array<Record<string, unknown>> } | null;
  if (!parsed?.services) return [];
  const out: ServiceEntry[] = [];
  for (const s of parsed.services) {
    if (typeof s.code !== 'string' || typeof s.log_path !== 'string') continue;
    out.push({
      code: s.code,
      name: typeof s.name === 'string' ? s.name : s.code,
      log_path: path.resolve(s.log_path),
    });
  }
  return out;
}

function findService(catalog: ServiceEntry[], code: string): ServiceEntry | undefined {
  return catalog.find((s) => s.code === code);
}

function formatRecord(rec: VestigiumRecord): string {
  const iso = new Date(rec.ts).toISOString();
  const ctx = rec.ctx ? ' ' + JSON.stringify(rec.ctx) : '';
  return `${iso} ${rec.level.toUpperCase().padEnd(5)} [${rec.channel}] ${rec.msg}${ctx}`;
}

async function main(): Promise<void> {
  const catalogPath = process.env.VESTIGIUM_CATALOG_PATH
    ?? path.resolve(process.cwd(), 'catalog/services.yaml');

  const reloadCatalog = (): ServiceEntry[] => {
    try {
      return loadCatalog(catalogPath);
    } catch (err) {
      process.stderr.write(`[vestigium-mcp] catalog load failed: ${(err as Error).message}\n`);
      return [];
    }
  };

  const server = new McpServer(
    { name: 'concordia-vestigium', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'vestigium_list_services',
    {
      description: 'List services that have Vestigium log_path configured. Each entry includes log directory and last-seen timestamp.',
      inputSchema: {},
    },
    async () => {
      const catalog = reloadCatalog();
      const services = catalog.map((s) => ({
        code: s.code,
        name: s.name,
        log_path: s.log_path,
        last_seen_at: lastSeenAt(s.log_path),
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ services }, null, 2) }],
      };
    },
  );

  server.registerTool(
    'vestigium_tail',
    {
      description: 'Return the most recent N log lines for one service. Default 200, max 2000.',
      inputSchema: {
        service: z.string().describe('Service code (matches catalog `code`)'),
        lines: z.number().int().min(1).max(2000).optional().describe('Max lines, default 200'),
        since_ms: z.number().int().optional().describe('Epoch ms — only return entries newer than this'),
      },
    },
    async ({ service, lines, since_ms }) => {
      const catalog = reloadCatalog();
      const svc = findService(catalog, service);
      if (!svc) {
        return {
          isError: true,
          content: [{ type: 'text', text: `service "${service}" not found in catalog (or has no log_path)` }],
        };
      }
      const recs = recent({
        logPath: svc.log_path,
        limit: lines ?? 200,
        since: since_ms,
      });
      return {
        content: [{
          type: 'text',
          text: recs.reverse().map(formatRecord).join('\n') || '(no entries)',
        }],
      };
    },
  );

  server.registerTool(
    'vestigium_search',
    {
      description: 'Cross-service regex search over Vestigium logs. Patterns are case-insensitive ECMAScript regex applied to the msg field.',
      inputSchema: {
        services: z.array(z.string()).min(1).describe('Service codes to search'),
        pattern: z.string().describe('Regex (case-insensitive)'),
        limit: z.number().int().min(1).max(2000).optional(),
        since_ms: z.number().int().optional(),
      },
    },
    async ({ services, pattern, limit, since_ms }) => {
      const catalog = reloadCatalog();
      const targets = services
        .map((code) => findService(catalog, code))
        .filter((s): s is ServiceEntry => s !== undefined)
        .map((s) => ({ code: s.code, logPath: s.log_path }));
      if (targets.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'no matching services with log_path found' }],
        };
      }
      const hits = search({
        logPaths: targets,
        pattern,
        limit: limit ?? 200,
        since: since_ms,
      });
      return {
        content: [{
          type: 'text',
          text: hits.length === 0
            ? '(no hits)'
            : hits.reverse().map((r) => `${r.service.padEnd(20)} ${formatRecord(r)}`).join('\n'),
        }],
      };
    },
  );

  server.registerTool(
    'vestigium_recent_errors',
    {
      description: 'Return recent error/fatal level entries across one or more services. Default: all configured services.',
      inputSchema: {
        services: z.array(z.string()).optional().describe('Optional service codes filter; omit to scan all'),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ services, limit }) => {
      const catalog = reloadCatalog();
      const targets = services && services.length > 0
        ? catalog.filter((s) => services.includes(s.code))
        : catalog;
      if (targets.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'no services available' }],
        };
      }
      const all: VestigiumRecord[] = [];
      for (const t of targets) {
        const recs = recent({
          logPath: t.log_path,
          limit: 1000,
          level: ['error', 'fatal'],
        });
        for (const r of recs) all.push(r);
      }
      all.sort((a, b) => b.ts - a.ts);
      const trimmed = all.slice(0, limit ?? 50);
      return {
        content: [{
          type: 'text',
          text: trimmed.length === 0
            ? '(no errors)'
            : trimmed.reverse().map((r) => `${r.service.padEnd(20)} ${formatRecord(r)}`).join('\n'),
        }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[vestigium-mcp] connected via stdio\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`[vestigium-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
