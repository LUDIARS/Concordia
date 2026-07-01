#!/usr/bin/env node
// Concordia AI agent persistent client.
//
// このスクリプトを Claude Code / Codex 等の SessionStart hook で detached spawn し、
// SessionEnd hook で SIGTERM を送る. 接続中は Concordia の sessions.ws_clients > 0
// なので、 sweeper の lost 判定から除外される (= 「作業中なのに ended」 を防ぐ).
//
// Usage:
//   node tools/concordia-agent-client.mjs --session <id> [--url <ws-url>] [--log <path>]
//
// Defaults:
//   --url  ws://127.0.0.1:11111/ws
//   --log  stdout
//
// 出力は JSON Lines (1 行 1 イベント). AI agent はこのログを tail することで
// Concordia 上の他 session の動きを「リアルタイムでモニター」 できる.

import { WebSocket } from 'ws';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv } from 'node:process';

function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const session = arg('--session') ?? arg('-s');
const url = arg('--url', 'ws://127.0.0.1:11111/ws');
const logPath = arg('--log');

if (!session) {
  console.error('Concordia agent client: --session <id> is required');
  process.exit(2);
}
if (logPath) {
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* swallow */ }
}

const target = `${url}?session=${encodeURIComponent(session)}`;

// 自分の pid を Concordia の session.metadata に登録する (best-effort)。
// WS の終了イベントを取りこぼした場合でも、 Concordia 側が agent_client_pid で
// このプロセスを確定的に kill できるようにする (session-end / reaper の保険)。
function httpBaseFromWs(wsUrl) {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
function registerPid() {
  const base = httpBaseFromWs(url);
  if (!base || typeof fetch !== 'function') return;
  void fetch(`${base}/v1/sessions/${encodeURIComponent(session)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { agent_client_pid: process.pid } }),
  }).catch(() => { /* best-effort */ });
}

let stopped = false;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 30_000;
/** @type {WebSocket | null} */
let current = null;

function write(obj) {
  const line = JSON.stringify(obj) + '\n';
  if (logPath) {
    try { appendFileSync(logPath, line); } catch { /* swallow */ }
  } else {
    try { process.stdout.write(line); } catch { /* swallow */ }
  }
}

function connect() {
  if (stopped) return;
  const ws = new WebSocket(target);
  current = ws;
  ws.on('open', () => {
    backoffMs = 1000;
    write({ _client: 'agent', _ts: Date.now(), event: 'connected', target });
  });
  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(String(data)); } catch { parsed = { raw: String(data) }; }
    write({ _client: 'agent', _ts: Date.now(), event: 'message', body: parsed });

    // 自セッションが終了状態に遷移したら self-shutdown.
    // Concordia の eventBus が emit する type:
    //   - session.ended    (DELETE /v1/sessions/:id)
    //   - session.lost     (sweeper が lost 化)
    //   - session.abandoned (sweeper が abandoned 化)
    // session_id が自分と一致したときだけ反応 (他 session の event は無視).
    if (parsed && typeof parsed === 'object'
        && parsed.session_id === session
        && (parsed.type === 'session.ended'
          || parsed.type === 'session.lost'
          || parsed.type === 'session.abandoned')) {
      write({ _client: 'agent', _ts: Date.now(), event: 'self-shutdown', reason: parsed.type });
      shutdown(parsed.type);
    }
  });
  ws.on('error', (err) => {
    write({ _client: 'agent', _ts: Date.now(), event: 'error', message: String(err?.message ?? err) });
  });
  ws.on('close', () => {
    current = null;
    write({ _client: 'agent', _ts: Date.now(), event: 'closed' });
    if (stopped) return;
    const wait = Math.min(backoffMs, MAX_BACKOFF_MS);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(connect, wait);
  });
}

function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  write({ _client: 'agent', _ts: Date.now(), event: 'shutdown', signal });
  if (current && current.readyState === WebSocket.OPEN) {
    try { current.close(1000, 'agent shutdown'); } catch { /* swallow */ }
  }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

write({ _client: 'agent', _ts: Date.now(), event: 'starting', target, session });
registerPid();
connect();
