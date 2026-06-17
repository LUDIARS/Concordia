/**
 * Delegation MCP server (stdio).
 *
 * 起動: `node dist/mcp/delegation-server.js`
 * .claude/mcp_servers.json (Claude) or codex の equivalent から:
 *   {
 *     "mcpServers": {
 *       "concordia-delegation": {
 *         "command": "node",
 *         "args": ["E:/Document/Ars/Concordia/dist/mcp/delegation-server.js"],
 *         "env": {
 *           "CONCORDIA_BASE_URL": "http://127.0.0.1:17330",
 *           "CONCORDIA_SPAWN_TOKEN_PATH": "E:/Document/Ars/Concordia/.spawn.token"
 *         }
 *       }
 *     }
 *   }
 *
 * 2 tools:
 *   - delegation_list_templates
 *   - delegation_invoke
 *
 * Concordia HTTP loopback を直接叩く構造。 DB に直触りしない (Concordia が
 * running していなければ動かない、 でも spawn の責任分界が明確になる).
 */

import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DEFAULT_BASE = "http://127.0.0.1:17330";

function loadToken(): string | null {
  const path = process.env.CONCORDIA_SPAWN_TOKEN_PATH;
  if (!path || !existsSync(path)) return null;
  try {
    const t = readFileSync(path, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

async function callConcordia(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  requireAuth = false,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = process.env.CONCORDIA_BASE_URL ?? DEFAULT_BASE;
  const url = `${base.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (requireAuth) {
    const tok = loadToken();
    if (!tok) {
      return {
        ok: false,
        status: 0,
        body: {
          error: "spawn token not available (set CONCORDIA_SPAWN_TOKEN_PATH env to the .spawn.token file path)",
        },
      };
    }
    headers.authorization = `Bearer ${tok}`;
  }
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: `fetch failed: ${(err as Error).message}` },
    };
  }
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "concordia-delegation", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "delegation_list_templates",
    {
      description:
        "List active delegation templates registered in Concordia. Each template has a call_name (used to invoke), target_provider (codex / claude / gemini), title, description, and input_schema.",
      inputSchema: {
        include_inactive: z.boolean().optional().describe("Also return inactive templates"),
      },
    },
    async ({ include_inactive }) => {
      const path = include_inactive ? "/v1/delegation/templates/all" : "/v1/delegation/templates";
      const r = await callConcordia("GET", path);
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `concordia call failed (${r.status}): ${JSON.stringify(r.body)}` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }] };
    },
  );

  server.registerTool(
    "delegation_invoke",
    {
      description:
        "Invoke a registered delegation template. Concordia renders the prompt, writes it to a markdown file, and spawns the target agent (Codex / Claude / Gemini) in a new Windows Terminal window. Returns the spawn pid and the rendered prompt file path.",
      inputSchema: {
        call_name: z.string().describe("Template call_name, e.g. 'fix-bug'"),
        args: z.record(z.unknown()).optional().describe("Variable bindings for the template (object)"),
        cwd: z.string().optional().describe("Working directory for the spawned session"),
        triggered_by: z.string().optional().describe("Who is initiating (free-form identifier)"),
        spawn: z.boolean().optional().describe("false で render + 記録のみ (no spawn)"),
      },
    },
    async ({ call_name, args, cwd, triggered_by, spawn }) => {
      const r = await callConcordia(
        "POST",
        "/v1/delegation/invoke",
        { call_name, args: args ?? {}, cwd, triggered_by, spawn },
        true,
      );
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `concordia call failed (${r.status}): ${JSON.stringify(r.body)}` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[concordia-delegation-mcp] connected via stdio\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`[concordia-delegation-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
