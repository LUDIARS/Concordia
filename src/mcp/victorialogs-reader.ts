/**
 * VictoriaLogs から Vestigium のサービスログを読む reader。
 *
 * ログの正本は Vestigium の送り出し (vestigium-sink) が VictoriaLogs へ送った行
 * (Vestigium spec/feature/victorialogs-sink.md)。行は `_time`・`_msg` と、
 * `service`・`kind`・`level`・`channel`・`pid`・`ctx.*` の検索フィールドを持つ。
 * 返す形はファイル reader (vestigium-reader.ts) の VestigiumRecord にそろえる。
 *
 * neco 指示 (2026-11-25): ログは VictoriaLogs で管理する。
 */

import type { VestigiumRecord } from './vestigium-reader.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const CHANNELS = ['stdout', 'stderr', 'app', 'llm'] as const;
const SERVICE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_LIMIT = 5_000;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface VictoriaLogsReaderOptions {
  origin: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** サービスコードとして安全な値だけを通す (LogsQL に埋め込むため)。 */
export function isServiceCode(value: string): boolean {
  return SERVICE_CODE.test(value);
}

/** VictoriaLogs の 1 行 (JSON) を VestigiumRecord にする。必要な値を欠く行は null。 */
export function toVestigiumRecord(row: Record<string, unknown>): VestigiumRecord | null {
  const time = typeof row._time === 'string' ? Date.parse(row._time) : Number.NaN;
  if (!Number.isFinite(time) || typeof row.service !== 'string' || typeof row._msg !== 'string') return null;
  const level = (LEVELS as readonly string[]).includes(row.level as string)
    ? (row.level as VestigiumRecord['level']) : 'info';
  const channel = (CHANNELS as readonly string[]).includes(row.channel as string)
    ? (row.channel as VestigiumRecord['channel']) : 'app';
  const ctx: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('ctx.')) ctx[key.slice(4)] = value;
  }
  const pid = typeof row.pid === 'string' && /^\d+$/.test(row.pid) ? Number(row.pid)
    : typeof row.pid === 'number' ? row.pid : undefined;
  return {
    ts: time,
    level,
    service: row.service,
    channel,
    msg: row._msg,
    pid,
    ctx: Object.keys(ctx).length > 0 ? ctx : undefined,
  };
}

/** サービスログ (kind:service) を絞る LogsQL。値はすべて検査済みのものだけを埋め込む。 */
export function serviceLogQuery(input: {
  services: readonly string[];
  levels?: readonly VestigiumRecord['level'][];
  sinceMs?: number;
}): string {
  const services = input.services.filter(isServiceCode);
  if (services.length === 0) throw new Error('no valid service code');
  const parts = ['kind:service', `service:in(${services.map((s) => JSON.stringify(s)).join(',')})`];
  const levels = (input.levels ?? []).filter((l) => (LEVELS as readonly string[]).includes(l));
  if (levels.length > 0) parts.push(`level:in(${levels.join(',')})`);
  if (input.sinceMs !== undefined && Number.isFinite(input.sinceMs)) {
    parts.push(`_time:>=${new Date(input.sinceMs).toISOString()}`);
  }
  return parts.join(' AND ');
}

function boundedLimit(limit: number | undefined, fallback: number): number {
  const value = Math.trunc(limit ?? fallback);
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}

export function createVictoriaLogsReader(options: VictoriaLogsReaderOptions) {
  const origin = new URL(options.origin);
  if (origin.username || origin.password) throw new Error('credentials in the VictoriaLogs URL are not allowed');
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get(pathname: string, params: Record<string, string>): Promise<string> {
    const url = new URL(pathname, origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`VictoriaLogs ${pathname} HTTP ${response.status}`);
    return response.text();
  }

  /** 新しい順に返す (ファイル reader の recent と同じ並び)。 */
  async function query(logsql: string, limit: number): Promise<VestigiumRecord[]> {
    const text = await get('/select/logsql/query', { query: `${logsql} | sort by (_time desc) | limit ${limit}` });
    const records: VestigiumRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = toVestigiumRecord(JSON.parse(line) as Record<string, unknown>);
        if (record) records.push(record);
      } catch { /* 壊れた行は読み飛ばす */ }
    }
    return records;
  }

  return {
    async listServices(): Promise<string[]> {
      const text = await get('/select/logsql/field_values', { query: 'kind:service AND _time:7d', field: 'service' });
      const parsed = JSON.parse(text) as { values?: Array<{ value?: unknown }> };
      return (parsed.values ?? [])
        .map((entry) => entry.value)
        .filter((value): value is string => typeof value === 'string' && isServiceCode(value))
        .sort();
    },

    async recent(input: { service: string; limit?: number; level?: VestigiumRecord['level'][]; since?: number }): Promise<VestigiumRecord[]> {
      return query(serviceLogQuery({ services: [input.service], levels: input.level, sinceMs: input.since }), boundedLimit(input.limit, 200));
    },

    /** 正規表現は ECMAScript のまま Concordia 側で当てる (ファイル reader と同じ意味にする)。 */
    async search(input: { services: string[]; pattern: string | RegExp; limit?: number; since?: number }): Promise<VestigiumRecord[]> {
      const re = typeof input.pattern === 'string' ? new RegExp(input.pattern, 'i') : input.pattern;
      const rows = await query(serviceLogQuery({ services: input.services, sinceMs: input.since }), MAX_LIMIT);
      return rows.filter((row) => re.test(row.msg)).slice(0, boundedLimit(input.limit, 200));
    },

    async lastSeenAt(service: string): Promise<number | null> {
      const [latest] = await query(serviceLogQuery({ services: [service] }), 1);
      return latest?.ts ?? null;
    },
  };
}

export type VictoriaLogsReader = ReturnType<typeof createVictoriaLogsReader>;
