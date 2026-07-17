/**
 * Vestigium JSONL ファイルを読む小さな reader。 file-tail と MCP server の両方で使う。
 * Vestigium DESIGN.md §2.2 が spec の正本。 @ludiars/vestigium への直接依存を避ける
 * ため Concordia 内で再実装している (drift 注意 — spec 変更時は両方更新)。
 */

import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface VestigiumRecord {
  ts: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  service: string;
  channel: 'stdout' | 'stderr' | 'app' | 'llm';
  msg: string;
  pid?: number;
  ctx?: Record<string, unknown>;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const CHANNELS = ['stdout', 'stderr', 'app', 'llm'] as const;

export function parseRecord(line: string): VestigiumRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.ts !== 'number' || typeof obj.service !== 'string' || typeof obj.msg !== 'string') {
      return null;
    }
    const level = (LEVELS as readonly string[]).includes(obj.level as string)
      ? (obj.level as VestigiumRecord['level'])
      : 'info';
    const channel = (CHANNELS as readonly string[]).includes(obj.channel as string)
      ? (obj.channel as VestigiumRecord['channel'])
      : 'app';
    return {
      ts: obj.ts,
      level,
      service: obj.service,
      channel,
      msg: obj.msg,
      pid: typeof obj.pid === 'number' ? obj.pid : undefined,
      ctx: obj.ctx && typeof obj.ctx === 'object'
        ? (obj.ctx as Record<string, unknown>)
        : undefined,
    };
  } catch {
    return null;
  }
}

/** logsDir 配下 (= log_path の親) で <code>/ サブディレクトリを列挙 */
export async function listVestigiumServices(logsRoot: string): Promise<string[]> {
  try {
    return (await readdir(logsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** ある service の log_path 配下の YYYY-MM-DD.jsonl を新しい順 */
export async function listFiles(logPath: string): Promise<string[]> {
  try {
    return (await readdir(logPath))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse()
      .map((f) => path.join(logPath, f));
  } catch {
    return [];
  }
}

/** 末尾 256KB から行単位に読む簡易 reverse reader */
async function readTailLines(file: string, maxBytes = 256 * 1024): Promise<string[]> {
  const fh = await open(file, 'r');
  let buffer: Buffer;
  let offset: number;
  try {
    const stat = await fh.stat();
    const readBytes = Math.min(stat.size, maxBytes);
    offset = stat.size - readBytes;
    buffer = Buffer.alloc(readBytes);
    await fh.read(buffer, 0, readBytes, offset);
  } finally {
    await fh.close();
  }
  const lines = buffer.toString('utf8').split('\n');
  if (offset > 0 && lines.length > 0) lines.shift();
  return lines.filter((l) => l.length > 0).reverse();
}

export interface RecentOpts {
  logPath: string;
  limit?: number;
  level?: VestigiumRecord['level'][];
  since?: number;
}

export async function recent(opts: RecentOpts): Promise<VestigiumRecord[]> {
  const limit = opts.limit ?? 200;
  const result: VestigiumRecord[] = [];
  for (const file of await listFiles(opts.logPath)) {
    for (const line of await readTailLines(file)) {
      const rec = parseRecord(line);
      if (!rec) continue;
      if (opts.level && !opts.level.includes(rec.level)) continue;
      if (opts.since !== undefined && rec.ts < opts.since) return result;
      result.push(rec);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

export interface SearchOpts {
  logPaths: { code: string; logPath: string }[];
  pattern: string | RegExp;
  limit?: number;
  since?: number;
}

export async function search(opts: SearchOpts): Promise<VestigiumRecord[]> {
  const re = typeof opts.pattern === 'string' ? new RegExp(opts.pattern, 'i') : opts.pattern;
  const limit = opts.limit ?? 200;
  const all: VestigiumRecord[] = [];
  for (const target of opts.logPaths) {
    const hits = (await recent({ logPath: target.logPath, limit: 5000, since: opts.since }))
      .filter((r) => re.test(r.msg));
    for (const h of hits) all.push(h);
  }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit);
}

export async function lastSeenAt(logPath: string): Promise<number | null> {
  const files = await listFiles(logPath);
  if (files.length === 0) return null;
  const last = (await readTailLines(files[0]!)).find((l) => parseRecord(l) !== null);
  if (!last) return null;
  return parseRecord(last)?.ts ?? null;
}
