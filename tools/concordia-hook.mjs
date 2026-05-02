#!/usr/bin/env node
/**
 * Concordia hook wrapper.
 *
 * Claude Code (or 任意の AI agent) の hook 機構から呼ばれて、 Concordia
 * backend の HTTP API を叩く. backend が止まっていても exit 0 で抜け、
 * agent 側の動作を阻害しない (hook の安全弁).
 *
 * 使い方:
 *   node tools/concordia-hook.mjs <event>
 *     <event> = session-start | prompt | edit | compact | session-end
 *
 *   node tools/concordia-hook.mjs event --kind=foo --payload='{"x":1}'
 *
 * stdin: Claude Code の hook 機構が JSON で渡す情報を読む.
 *
 * env override:
 *   CONCORDIA_URL          — default http://127.0.0.1:17330
 *   CONCORDIA_PROVIDER     — default claude-code
 *   CONCORDIA_DISABLE      — "1" で no-op
 *   CONCORDIA_TIMEOUT_MS   — default 1500
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { execSync } from "node:child_process";

if (process.env.CONCORDIA_DISABLE === "1") process.exit(0);

const URL_BASE = (process.env.CONCORDIA_URL ?? "http://127.0.0.1:17330").replace(/\/+$/, "");
const PROVIDER = process.env.CONCORDIA_PROVIDER ?? "claude-code";
const TIMEOUT_MS = Number(process.env.CONCORDIA_TIMEOUT_MS ?? "1500");

const event = process.argv[2] ?? "noop";
const flags = parseFlags(process.argv.slice(3));

main().catch((err) => {
  process.stderr.write(`[concordia-hook] ${(err && err.message) || err}\n`);
  process.exit(0); // 失敗してもエージェント動作は阻害しない
});

async function main() {
  const stdin = readStdin();
  const ctx = stdin ? safeJson(stdin) : null;
  const cwd = ctx?.cwd ?? process.cwd();
  const sessionId = ctx?.session_id ?? process.env.CLAUDE_SESSION_ID ?? process.env.CONCORDIA_SESSION_ID ?? null;
  const transcriptPath = ctx?.transcript_path ?? null;

  switch (event) {
    case "session-start":
      await sessionStart({ sessionId, cwd, transcriptPath });
      return;
    case "prompt":
      await appendEvent(sessionId, "prompt", {
        summary: ctx?.user_prompt?.slice(0, 200),
        length: ctx?.user_prompt?.length,
      });
      return;
    case "edit":
      await appendEvent(sessionId, "edit", {
        file: ctx?.tool_input?.file_path ?? ctx?.tool_input?.path ?? null,
        tool: ctx?.tool_name ?? null,
      });
      return;
    case "compact":
      await appendEvent(sessionId, "compact", {
        kept_messages: ctx?.kept_messages ?? null,
      });
      return;
    case "session-end":
      await sessionEnd({ sessionId });
      return;
    case "event":
      await appendEvent(sessionId, flags.kind ?? "note", safeJson(flags.payload ?? "{}") ?? {});
      return;
    default:
      process.exit(0);
  }
}

async function sessionStart({ sessionId, cwd, transcriptPath }) {
  if (!sessionId) return;
  const repoOrigin = tryGitRemote(cwd);
  const branch = tryGitBranch(cwd);
  const body = {
    id: sessionId,
    provider: PROVIDER,
    repo_path: cwd,
    repo_origin: repoOrigin,
    branch,
    host: hostname(),
    transcript_path: transcriptPath,
  };
  const res = await postJson("/v1/sessions", body);
  // hook stdout は Claude Code が `additionalContext` として AI に流す.
  if (res?.advisory) {
    const a = res.advisory;
    const lines = [];
    if (a.active_peer_count > 0) {
      lines.push(`[concordia] このリポジトリで他に ${a.active_peer_count} 件の active session があります.`);
    }
    if (a.branch_conflict && a.worktree_command) {
      lines.push(`[concordia] 同 branch (${branch}) で並行作業が発生中です. 干渉しそうなら別 worktree を切ってください:`);
      lines.push(`  ${a.worktree_command}`);
    }
    if (Array.isArray(res.lost_candidates) && res.lost_candidates.length > 0) {
      lines.push(`[concordia] 同 host で lost 状態のセッションが ${res.lost_candidates.length} 件あります (引継ぎ可).`);
    }
    if (lines.length) process.stdout.write(lines.join("\n") + "\n");
  }
}

async function appendEvent(sessionId, kind, payload) {
  if (!sessionId) return;
  await postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/event`, { kind, payload });
}

async function sessionEnd({ sessionId }) {
  if (!sessionId) return;
  const res = await fetchJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (res?.report?.summary_md) {
    process.stdout.write(`[concordia] session report:\n${res.report.summary_md}\n`);
  }
}

// ─── helpers ─────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function parseFlags(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function postJson(path, body) {
  return fetchJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchJson(path, init = {}) {
  const url = `${URL_BASE}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function tryGitRemote(cwd) {
  try {
    return execSync("git config --get remote.origin.url", {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}
function tryGitBranch(cwd) {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}
