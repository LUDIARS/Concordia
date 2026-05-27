/**
 * Vestigium が吐いた JSONL log file を tail して、 既存の log bus に流す bridge。
 *
 * - catalog.service.log_path が指定された service のみ起動
 * - 当日 YYYY-MM-DD.jsonl を follow + 日付境界で次 file へ自動切替
 * - 1 行 = JSON parse → bus.publish({service_code, channel, ts, line})
 * - 既存 error-detector はそのまま再利用 (bus 経由)
 *
 * @ludiars/vestigium への直接依存は避けたい (Concordia の CI を Vestigium repo
 * から切り離すため)。 ここでは Vestigium の JSONL spec を直接 implement する。
 * spec の正本は LUDIARS/Vestigium/DESIGN.md §2.2。
 */

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { publish, type Channel } from './bus.js';
import type { Catalog, Service } from '../catalog/loader.js';

const logger = pino({ name: 'concordia.file-tail' });

interface TailState {
  service: Service;
  logsDir: string;
  currentFile: string;
  currentYmd: string;
  offset: number;
  buf: string;
}

const states = new Map<string, TailState>();
let timer: NodeJS.Timeout | null = null;

const POLL_MS = 1000;

function ymdUtc(when: Date): string {
  const y = when.getUTCFullYear().toString().padStart(4, '0');
  const m = (when.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = when.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayFile(logsDir: string, when: Date): string {
  return path.join(logsDir, `${ymdUtc(when)}.jsonl`);
}

function startTailing(svc: Service): void {
  if (!svc.log_path) return;
  if (states.has(svc.code)) return;
  const logsDir = path.resolve(svc.log_path);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    logger.warn({ code: svc.code, err: (err as Error).message }, 'failed to ensure logs dir');
  }
  const now = new Date();
  const currentFile = dayFile(logsDir, now);
  let offset = 0;
  try {
    if (fs.existsSync(currentFile)) {
      offset = fs.statSync(currentFile).size; // start at end (live tail)
    }
  } catch { /* noop */ }
  states.set(svc.code, {
    service: svc,
    logsDir,
    currentFile,
    currentYmd: ymdUtc(now),
    offset,
    buf: '',
  });
  logger.info({ code: svc.code, logs_dir: logsDir, file: currentFile, offset }, 'file-tail started');
}

function stopTailing(code: string): void {
  states.delete(code);
}

function drainOne(state: TailState): void {
  const now = new Date();
  const today = ymdUtc(now);
  if (today !== state.currentYmd) {
    readMore(state);
    state.currentYmd = today;
    state.currentFile = dayFile(state.logsDir, now);
    state.offset = 0;
    state.buf = '';
  }
  readMore(state);
}

function readMore(state: TailState): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(state.currentFile);
  } catch {
    return; // file not yet created
  }
  if (stat.size < state.offset) {
    state.offset = 0;
    state.buf = '';
  }
  if (stat.size === state.offset) return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(state.currentFile, 'r');
    const need = stat.size - state.offset;
    const buffer = Buffer.alloc(need);
    fs.readSync(fd, buffer, 0, need, state.offset);
    state.offset = stat.size;
    state.buf += buffer.toString('utf8');
    let nl: number;
    while ((nl = state.buf.indexOf('\n')) !== -1) {
      const line = state.buf.slice(0, nl);
      state.buf = state.buf.slice(nl + 1);
      handleLine(state.service, line);
    }
  } catch (err) {
    logger.warn({ code: state.service.code, err: (err as Error).message }, 'readMore failed');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

function handleLine(svc: Service, raw: string): void {
  if (!raw.trim()) return;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const ts = typeof obj.ts === 'number' ? new Date(obj.ts) : new Date();
    const channel = (obj.channel === 'stderr' || obj.channel === 'stdout')
      ? (obj.channel as Channel)
      : ('stdout' as Channel);
    const msg = typeof obj.msg === 'string' ? obj.msg : raw;
    void publish({
      service_code: svc.code,
      channel,
      ts,
      line: msg,
    });
  } catch {
    // 非 JSON line — そのまま stdout として publish
    void publish({
      service_code: svc.code,
      channel: 'stdout',
      ts: new Date(),
      line: raw,
    });
  }
}

export interface FileTailHandle {
  stop(): void;
  refresh(catalog: Catalog): void;
}

export function startFileTail(catalog: Catalog): FileTailHandle {
  refresh(catalog);
  timer = setInterval(() => {
    for (const state of states.values()) {
      try { drainOne(state); } catch (err) {
        logger.warn({ code: state.service.code, err: (err as Error).message }, 'drain failed');
      }
    }
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      states.clear();
    },
    refresh,
  };
}

function refresh(catalog: Catalog): void {
  const wantedCodes = new Set<string>();
  for (const svc of catalog.services) {
    if (!svc.log_path) continue;
    wantedCodes.add(svc.code);
    if (!states.has(svc.code)) startTailing(svc);
  }
  for (const code of Array.from(states.keys())) {
    if (!wantedCodes.has(code)) stopTailing(code);
  }
}

/** test 用 — 現在 tail 中のサービスコード一覧 */
export function _tailingCodes(): string[] {
  return Array.from(states.keys());
}
