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
 *   CONCORDIA_URL          — default http://127.0.0.1:11111
 *   CONCORDIA_PROVIDER     — default claude-code
 *   CONCORDIA_DISABLE      — "1" で no-op
 *   CONCORDIA_TIMEOUT_MS   — default 1500
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname, homedir } from "node:os";
import { execSync } from "node:child_process";
import {
  resolveSessionId,
  pickActiveSessionId,
  resolvePromptText,
  resolveEditTarget,
} from "./concordia-hook-resolver.mjs";

// ホワイトリスト方式: 既定は無効, CONCORDIA_HOOK=1 が console から渡された
// セッションでのみ動く. これにより claude CLI 由来の one-shot や Agent ツール
// 経由のサブセッションは Concordia と無関係にできる.
// 例外: 対話で手動登録された session (POST /v1/sessions 済) は env 無くても hook を通す.
//       session-start だけは env 必須 (sub-agent の自動登録を防ぐ).
const HOOK_ENV_OPT_IN = process.env.CONCORDIA_HOOK === "1";
// レガシー対応: CONCORDIA_DISABLE=1 が明示的にセットされてれば従来どおり no-op
if (process.env.CONCORDIA_DISABLE === "1") process.exit(0);

const URL_BASE = (process.env.CONCORDIA_URL ?? "http://127.0.0.1:11111").replace(/\/+$/, "");
const PROVIDER = process.env.CONCORDIA_PROVIDER ?? "claude-code";
const TIMEOUT_MS = Number(process.env.CONCORDIA_TIMEOUT_MS ?? "1500");

const event = process.argv[2] ?? "noop";
const flags = parseFlags(process.argv.slice(3));
const QUIET_STDOUT = event === "prompt";

main().catch((err) => {
  process.stderr.write(`[concordia-hook] ${(err && err.message) || err}\n`);
  process.exit(0); // 失敗してもエージェント動作は阻害しない
});

async function main() {
  const stdin = readStdin();
  const ctx = stdin ? safeJson(stdin) : null;
  const cwd = ctx?.cwd ?? process.cwd();
  const transcriptPath = ctx?.transcript_path ?? null;

  // ── Session 解決 (混線対策) ───────────────────────────────────────────
  // 純粋フォールバックは resolveSessionId (env CONCORDIA_SESSION_ID 優先).
  // ただし CONCORDIA_SESSION_ID をグローバル export していると同ウインドウの
  // 全タブが同じ session の pending-tasks を pull してしまう。 そこで
  // session-start 以外は「ctx.session_id を最優先に並べ、 Concordia が active と
  // 確認できた最初の候補」 を採用する (pickActiveSessionId)。 Lictor 配下では
  // ctx.session_id (未登録の Claude UUID) が非 active なので CONCORDIA_SESSION_ID
  // に落ちる ⇒ PR #35 の挙動を維持しつつタブ間漏れだけを断つ。
  let sessionId = resolveSessionId(ctx, process.env);
  let sessionActive = false;
  if (event !== "session-start") {
    const picked = await pickActiveSessionId(ctx, process.env, isSessionActive);
    if (picked) {
      sessionId = picked;
      sessionActive = true;
    }
  }

  // Gate: env opt-in OR session が Concordia に active 登録済み (対話 enable flow).
  // session-start は env 必須 — sub-agent / one-shot CLI の自動登録を防ぐため.
  if (!HOOK_ENV_OPT_IN) {
    if (event === "session-start") return;
    if (!sessionId) return;
    if (!sessionActive) return; // どの候補も active な Concordia session ではない
  }

  switch (event) {
    case "session-start":
      await sessionStart({ sessionId, cwd, transcriptPath });
      return;
    case "prompt": {
      const text = resolvePromptText(ctx);
      await appendEvent(sessionId, "prompt", {
        summary: text.slice(0, 200),
        length: text.length,
      });
      return;
    }
    case "edit":
      await appendEvent(sessionId, "edit", {
        file: resolveEditTarget(ctx),
        tool: ctx?.tool_name ?? null,
      });
      return;
    case "compact":
      // Claude Code は `kept_messages`、 Codex CLI は `trigger` ("manual"|"auto") を渡す.
      await appendEvent(sessionId, "compact", {
        kept_messages: ctx?.kept_messages ?? null,
        trigger: ctx?.trigger ?? null,
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
    if (lines.length && !QUIET_STDOUT) process.stdout.write(lines.join("\n") + "\n");
  }
  // dev-process.md 由来の auto-start 結果を additionalContext に流す.
  if (res?.processes) {
    const ps = res.processes;
    const procLines = [];
    if (ps.started?.length)  procLines.push(`[concordia/processes] auto-started: ${ps.started.join(", ")}`);
    if (ps.skipped?.length)  procLines.push(`[concordia/processes] skipped (already running): ${ps.skipped.join(", ")}`);
    if (ps.failed?.length)   procLines.push(`[concordia/processes] failed: ${ps.failed.map((f) => `${f.name} (${f.reason})`).join(", ")}`);
    if (ps.warnings?.length) procLines.push(`[concordia/processes] warnings: ${ps.warnings.join(" / ")}`);
    if (procLines.length && !QUIET_STDOUT) {
      procLines.push(`[concordia/processes] ログ stream: ${res.process_stream_url ?? "ws://127.0.0.1:11111/ws"} (process.log / process.exited を購読)`);
      process.stdout.write(procLines.join("\n") + "\n");
    }
  }
  if (res?.context_packet?.cc_workflow && !QUIET_STDOUT) {
    process.stdout.write(formatCcWorkflow(res.context_packet) + "\n");
  }
  // persona 注入 (Concordia 経由の起動時のみ. ユーザの skill / memory には書かない).
  if (res?.initial_work && !QUIET_STDOUT) {
    const iw = res.initial_work;
    const lines = [
      "",
      "[concordia/initial-work]",
      "最初に、今回作業するブランチ/開発コードを確定してください。",
      "Concordia/Slack/Discord 側にも同じ選択UIを出しています。候補に無い場合や複数リポジトリにまたがる場合は自由入力を使えます。",
      "確定後はチャンネル名が「<branch>(<GitHub project>)開発中」になります。",
    ];
    const options = Array.isArray(iw.options) ? iw.options.slice(0, 8) : [];
    if (options.length) {
      lines.push("候補:");
      for (const o of options) lines.push(`  - ${o.label ?? String(o)}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
  if (res?.persona && res.persona.skill_template && !QUIET_STDOUT) {
    const reused = res.persona_reused ? " (再開: 既存 assign)" : "";
    process.stdout.write(
      `\n[concordia/persona] あなたに付与された人格: **${res.persona.name}**${reused}\n` +
      `------- persona skill (session 限定 / FS 書込みなし) -------\n` +
      String(res.persona.skill_template) + "\n" +
      `------- end persona skill -------\n`,
    );
  }
}

async function appendEvent(sessionId, kind, payload) {
  if (!sessionId) return;
  await postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/event`, { kind, payload });
  await dumpPendingTasks(sessionId);
  if (kind === "prompt") {
    // 自分の repo に紐づくプロセスの新しい error 行だけを 1 ブロックで注入.
    await dumpProcessLogs(sessionId);
  }
}

async function sessionEnd({ sessionId }) {
  if (!sessionId) return;
  // Claude Code の Stop hook は「ターン終了」(AI が応答を返した直後) で発火し、
  // 真の "session 終了" は別 event として存在しない。 ここで DELETE すると
  // 各 turn で session が ended 化して Member 表示が消える → 不便。
  // よって Stop では heartbeat だけ打って active を維持。
  // 真の終了 (per-session report 生成) は:
  //   (a) 手動 DELETE /v1/sessions/:id
  //   (b) long-idle で sweeper が lost → abandoned へ自然遷移
  // のどちらかで起こす。
  await postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {});
  await dumpPendingTasks(sessionId);
}

function formatCcWorkflow(packet) {
  const workflow = packet.cc_workflow;
  if (!workflow) return "";
  const lines = [
    "",
    "[concordia/cc-workflow]",
    "Use Concordia to make this session's work visible and finishable:",
  ];
  for (const rule of workflow.rules ?? []) lines.push(`- ${rule}`);
  lines.push("- Cc API:");
  lines.push(`  - update todos: ${workflow.task_api?.update_todos ?? "-"}`);
  lines.push(`  - list todos: ${workflow.task_api?.list_todos ?? "-"}`);
  lines.push(`  - pending notices: ${workflow.task_api?.list_pending ?? "-"}`);
  lines.push(`- Interrupts: ${workflow.interrupt_policy}`);
  for (const policy of workflow.completion_policy ?? []) lines.push(`- Completion: ${policy}`);
  return lines.join("\n");
}

async function dumpPendingTasks(sessionId) {
  const res = await fetchJson(`/v1/sessions/${encodeURIComponent(sessionId)}/pending-tasks`);
  const tasks = res?.tasks ?? [];
  if (tasks.length === 0 || QUIET_STDOUT) return;
  const lines = ["[Concordia tasks]"];
  for (const t of tasks) {
    const p = t.payload ?? {};
    // 注: session-departed / daily-report task は廃止 (離脱告知は中央 Haiku の司会発話、
    // 終了独白は report 経路)。 旧 DB に残骸があれば下の汎用描画で表示される。
    if (t.kind === "chat-reply" && p.is_actionable_suggestion) {
      lines.push(
        `#${t.id} chat-reply [HUMAN_CONFIRMATION_REQUIRED]`,
        `  対象 (${p.target_channel}/${p.target_author}): "${truncate(p.target_text)}"`,
        `  指示: ${p.instructions}`,
        `  ★この提案を直接実行せず、 まずユーザに「この提案を取り入れますか?」と確認してください。 reply 自体は短文で投稿して OK。`,
      );
      continue;
    }
    if (t.kind === "peer-log-react") {
      lines.push(
        `#${t.id} peer-log-react [${p.log_kind}]`,
        `  summary: ${truncate(p.summary, 200)}`,
        `  ref: ${p.ref ?? "-"} / role: ${p.role ?? "?"}`,
        `  ★この通知は active peer の中で **あなた 1 人だけ** に届いている (排他処理)。 chitchat か consultation に 1 文 reaction を出すか、 言うべきことが無ければ skip。`,
      );
      continue;
    }
    if (t.kind === "stat-collect") {
      const triggerLabel = p.trigger === "idle" ? " [idle/5min指示なし]" : "";
      lines.push(
        `#${t.id} stat-collect${triggerLabel}`,
        `  ${p.instructions ?? "現況を JSON で /v1/stat/<self_id> に POST"}`,
        `  ★ 簡潔な現況スナップショット (active_repos / open_prs / unmerged_branches / todos_summary / recent_work) を JSON で POST する。 投稿後はチャット投稿は不要。`,
      );
      continue;
    }
    if (t.kind === "title-suggest") {
      lines.push(
        `#${t.id} title-suggest`,
        `  ${p.instructions ?? "現在の作業のサマリを 30 文字以内にまとめて投稿"}`,
        `  ★作業内容を 30 文字以内 (日本語可、 OSC タイトル向け) にまとめ、 ` +
          `POST http://127.0.0.1:11111/v1/sessions/${encodeURIComponent(sessionId)}/title-suggestion ` +
          `{ "text": "<タイトル文字列>" } で投稿する。 Concordia がそれを Lictor の /v1/rename に転送して反映する。`,
      );
      continue;
    }
    if (t.kind === "pr-ci-followup") {
      lines.push(
        `#${t.id} pr-ci-followup [${p.ci_status ?? "unknown"}]`,
        `  PR: ${p.repo_origin ?? "?"}#${p.number ?? "?"} ${p.url ?? ""}`,
        `  ${p.instructions ?? "Review PR CI status and continue the PR workflow."}`,
      );
      continue;
    }
    lines.push(`#${t.id} ${t.kind}`, `  payload: ${JSON.stringify(p)}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function isSessionActive(sessionId) {
  const res = await fetchJson(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  return res?.session?.status === "active";
}

// process.log 注入用に、 自分のセッションが見ている repo_path を保持して
// hook 起動間で「直近 error 行を二重に貼らない」ようにする (file-based cursor).
function cursorPath(sessionId) {
  const dir = join(homedir(), ".cache", "concordia");
  return join(dir, `proc-cursor-${sessionId.slice(0, 32)}.json`);
}

function readCursor(sessionId) {
  const p = cursorPath(sessionId);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")) ?? {}; } catch { return {}; }
}

function writeCursor(sessionId, map) {
  const p = cursorPath(sessionId);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(map));
  } catch { /* swallow */ }
}

async function dumpProcessLogs(sessionId) {
  // 1. このセッションの repo_path を取得
  const sess = await fetchJson(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  const repoPath = sess?.session?.repo_path;
  if (!repoPath) return;
  // 2. その repo に紐づく processes 一覧
  const res = await fetchJson(`/v1/processes?repo_path=${encodeURIComponent(repoPath)}`);
  const procs = res?.processes ?? [];
  if (procs.length === 0) return;
  const cursor = readCursor(sessionId);
  const lines = [];
  for (const p of procs) {
    const since = Number(cursor[p.name] ?? 0);
    const lr = await fetchJson(
      `/v1/processes/${encodeURIComponent(p.name)}/logs?level=error&limit=20${since ? `&since_ts=${since}` : ""}`,
    );
    const logs = lr?.logs ?? [];
    if (logs.length === 0) {
      // クールド: 行が無くても running か exited か exit_code を出す (重複防止のため最初の 1 回のみ).
      if (cursor[p.name] === undefined) {
        const tag = p.live ? "running" : `exited(code=${p.exit_code ?? "?"})`;
        lines.push(`  ${p.name}: ${tag} cwd=${p.cwd}`);
        cursor[p.name] = nowSec();
      }
      continue;
    }
    lines.push(`  ${p.name} [${p.live ? "running" : "exited"}]: ${logs.length} 行の error`);
    for (const l of logs.slice(-5)) {
      lines.push(`    [${l.stream}] ${truncate(l.line, 300)}`);
    }
    const last = logs[logs.length - 1];
    cursor[p.name] = last?.ts ?? nowSec();
  }
  writeCursor(sessionId, cursor);
  if (lines.length === 0 || QUIET_STDOUT) return;
  process.stdout.write("[Concordia process logs]\n" + lines.join("\n") + "\n");
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function truncate(s, n = 80) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
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
