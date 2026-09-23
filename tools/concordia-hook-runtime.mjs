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
import { execFileSync } from "node:child_process";
import { observeReliability } from "./concordia-reliability-hook.mjs";
import {
  resolveSessionId,
  pickActiveSessionId,
  resolvePromptText,
  resolveEditTarget,
  resolveIsWorktree,
} from "./concordia-hook-resolver.mjs";

/** Each event owns its HTTP reachability and output destination. */
export async function runConcordiaHook(options) {
  if ((options.env ?? process.env).CONCORDIA_DISABLE === "1") return;
  return new HookInvocation(options).main();
}

class HookInvocation {
  constructor({ event, ctx = null, flags = {}, provider, env = process.env,
    output = text => process.stdout.write(text), fetchImpl = fetch }) {
    this.event = event;
    this.ctx = ctx;
    this.flags = flags;
    this.env = env;
    this.output = output;
    this.fetchImpl = fetchImpl;
    this.optIn = env.CONCORDIA_HOOK === "1";
    this.urlBase = (env.CONCORDIA_URL ?? "http://127.0.0.1:11111").replace(/\/+$/, "");
    this.provider = provider ?? env.CONCORDIA_PROVIDER ?? "claude-code";
    const timeout = Number(env.CONCORDIA_TIMEOUT_MS ?? "1500");
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 1500;
    this.gitTimeoutMs = 3000;
    this.quietStdout = event === "prompt";
    this.serverUnreachable = false;
  }

  async main() {
    const cwd = this.ctx?.cwd ?? process.cwd();
    const transcriptPath = this.ctx?.transcript_path ?? null;

    // ── Session 解決 (混線対策) ───────────────────────────────────────────
    // 純粋フォールバックは resolveSessionId (this.env CONCORDIA_SESSION_ID 優先).
    // ただし CONCORDIA_SESSION_ID をグローバル export していると同ウインドウの
    // 全タブが同じ session の pending-tasks を pull してしまう。 そこで
    // session-start 以外は「this.ctx.session_id を最優先に並べ、 Concordia が active と
    // 確認できた最初の候補」 を採用する (pickActiveSessionId)。 Lictor 配下では
    // this.ctx.session_id (未登録の Claude UUID) が非 active なので CONCORDIA_SESSION_ID
    // に落ちる ⇒ PR #35 の挙動を維持しつつタブ間漏れだけを断つ。
    let sessionId = resolveSessionId(this.ctx, this.env);
    let sessionActive = false;
    if (this.event !== "session-start") {
      const picked = await pickActiveSessionId(this.ctx, this.env, id => this.isSessionActive(id));
      if (picked) {
        sessionId = picked;
        sessionActive = true;
      }
    }

    // Gate: this.env opt-in OR session が Concordia に active 登録済み (対話 enable flow).
    // session-start は this.env 必須 — sub-agent / one-shot CLI の自動登録を防ぐため.
    if (!this.optIn) {
      if (this.event === "session-start") return;
      if (!sessionId) return;
      if (!sessionActive) return; // どの候補も active な Concordia session ではない
    }

    return this.dispatch(sessionId, cwd, transcriptPath);
  }

  async dispatch(sessionId, cwd, transcriptPath) {
    switch (this.event) {
      case "session-start":
        if (await this.isSessionActive(sessionId)) {
          await this.checkStartupPolicy(sessionId, cwd);
        }
        if (this.ctx?.source === "compact" || this.ctx?.source === "clear") {
          const result = await observeReliability({ event: "resume-compact", ctx: this.ctx, sessionId, post: this.postJson.bind(this) });
          if (result?.context) this.output(result.context + "\n");
          return;
        }
        await this.sessionStart({ sessionId, cwd, transcriptPath });
        return;
      case "prompt": {
        await this.checkStartupPolicy(sessionId, cwd);
        const text = resolvePromptText(this.ctx);
        const observation = await observeReliability({ event: this.event, ctx: { ...this.ctx, prompt: text }, sessionId, post: this.postJson.bind(this) });
        if (observation?.context) this.output(observation.context + "\n");
        await this.appendEvent(sessionId, "prompt", {
          summary: text.slice(0, 200),
          length: text.length,
        });
        return;
      }
      case "edit":
        await this.appendEvent(sessionId, "edit", {
          file: resolveEditTarget(this.ctx),
          tool: this.ctx?.tool_name ?? null,
        });
        return;
      case "compact":
        await observeReliability({ event: this.event, ctx: this.ctx, sessionId, post: this.postJson.bind(this) });
        // Claude Code は `kept_messages`、 Codex CLI は `trigger` ("manual"|"auto") を渡す.
        await this.appendEvent(sessionId, "compact", {
          kept_messages: this.ctx?.kept_messages ?? null,
          trigger: this.ctx?.trigger ?? null,
        });
        return;
      case "post-compact":
        await observeReliability({ event: this.event, ctx: this.ctx, sessionId, post: this.postJson.bind(this) });
        return;
      case "tool-result":
      case "tool-failure":
        {
          const result = await observeReliability({ event: this.event, ctx: this.ctx, sessionId, post: this.postJson.bind(this) });
          if (result?.context) this.output(JSON.stringify({ hookSpecificOutput: {
            hookEventName: this.event === "tool-failure" ? "PostToolUseFailure" : "PostToolUse", additionalContext: result.context,
          } }) + "\n");
        }
        return;
      case "session-end":
        await this.sessionEnd({ sessionId });
        return;
      case "event":
        await this.appendEvent(sessionId, this.flags.kind ?? "note", this.safeJson(this.flags.payload ?? "{}") ?? {});
        return;
      default:
        return;
    }
  }

  async sessionStart({ sessionId, cwd, transcriptPath }) {
    if (!sessionId) return;
    // Lictor registration is authoritative; observing a native hook must not
    // replace an explicit worktree binding with the client's original cwd.
    if (await this.isSessionActive(sessionId)) return;
    const repoOrigin = this.tryGitRemote(cwd);
    const branch = this.tryGitBranch(cwd);
    const isWorktree = resolveIsWorktree(cwd, (command, gitCwd) => execFileSync("git", command.split(" ").slice(1), {
      cwd: gitCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: this.gitTimeoutMs, windowsHide: true,
    }));
    const body = {
      id: sessionId,
      provider: this.provider,
      repo_path: cwd,
      repo_origin: repoOrigin,
      branch,
      host: hostname(),
      transcript_path: transcriptPath,
      metadata: { cc_hook_observation: true, ...(isWorktree === undefined ? {} : { is_worktree: isWorktree }) },
    };
    const res = await this.postJson("/v1/sessions", body);
    if (res?.session) await this.checkStartupPolicy(sessionId, cwd);
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
      if (lines.length && !this.quietStdout) this.output(lines.join("\n") + "\n");
    }
    // dev-process.md 由来の auto-start 結果を additionalContext に流す.
    if (res?.processes) {
      const ps = res.processes;
      const procLines = [];
      if (ps.started?.length)  procLines.push(`[concordia/processes] auto-started: ${ps.started.join(", ")}`);
      if (ps.skipped?.length)  procLines.push(`[concordia/processes] skipped (already running): ${ps.skipped.join(", ")}`);
      if (ps.failed?.length)   procLines.push(`[concordia/processes] failed: ${ps.failed.map((f) => `${f.name} (${f.reason})`).join(", ")}`);
      if (ps.warnings?.length) procLines.push(`[concordia/processes] warnings: ${ps.warnings.join(" / ")}`);
      if (procLines.length && !this.quietStdout) {
        procLines.push(`[concordia/processes] ログ stream: ${res.process_stream_url ?? "ws://127.0.0.1:11111/ws"} (process.log / process.exited を購読)`);
        this.output(procLines.join("\n") + "\n");
      }
    }
    if (res?.context_packet?.cc_workflow && !this.quietStdout) {
      this.output(this.formatCcWorkflow(res.context_packet) + "\n");
    }
    if (res?.initial_work && !this.quietStdout) {
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
      this.output(lines.join("\n") + "\n");
    }
  }

  async checkStartupPolicy(sessionId, cwd) {
    if (!sessionId) return;
    const result = await this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/startup-policy-check`, {
      cwd, branch: this.tryGitBranch(cwd), provider: this.provider,
    });
    if (result?.context) this.output(result.context + "\n");
    if (!result?.ok) process.stderr.write("[concordia-hook] Startup policy verification unavailable or mismatched; do not infer push permission.\n");
    else if (this.event === "session-start" && result.delivery === "unconfirmed") {
      process.stderr.write(`[concordia-hook] Policy ${result.revision}: injection queued; recipient delivery unconfirmed.\n`);
    }
  }

  async appendEvent(sessionId, kind, payload) {
    if (!sessionId) return;
    await this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/event`, { kind, payload });
    await this.dumpPendingTasks(sessionId);
    if (kind === "prompt") {
      // 自分の repo に紐づくプロセスの新しい error 行だけを 1 ブロックで注入.
      await this.dumpProcessLogs(sessionId);
    }
  }

  async sessionEnd({ sessionId }) {
    if (!sessionId) return;
    // Claude Code の Stop hook は「ターン終了」(AI が応答を返した直後) で発火し、
    // 真の "session 終了" は別 this.event として存在しない。 ここで DELETE すると
    // 各 turn で session が ended 化して Member 表示が消える → 不便。
    // よって Stop では heartbeat だけ打って active を維持。
    // 真の終了 (per-session report 生成) は:
    //   (a) 手動 DELETE /v1/sessions/:id
    //   (b) long-idle で sweeper が lost → abandoned へ自然遷移
    // のどちらかで起こす。
    await this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {});
    await this.dumpPendingTasks(sessionId);
  }

  formatCcWorkflow(packet) {
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

  async dumpPendingTasks(sessionId) {
    const res = await this.fetchJson(`/v1/sessions/${encodeURIComponent(sessionId)}/pending-tasks`);
    const tasks = res?.tasks ?? [];
    if (tasks.length === 0 || this.quietStdout) return;
    const lines = ["[Concordia tasks]"];
    for (const t of tasks) {
      const p = t.payload ?? {};
      // 注: session-departed / daily-report task は廃止 (離脱告知は中央 Haiku の司会発話、
      // 終了独白は report 経路)。 旧 DB に残骸があれば下の汎用描画で表示される。
      if (t.kind === "chat-reply" && p.is_actionable_suggestion) {
        lines.push(
          `#${t.id} chat-reply [HUMAN_CONFIRMATION_REQUIRED]`,
          `  対象 (${p.target_channel}/${p.target_author}): "${this.truncate(p.target_text)}"`,
          `  指示: ${p.instructions}`,
          `  ★この提案を直接実行せず、 まずユーザに「この提案を取り入れますか?」と確認してください。 reply 自体は短文で投稿して OK。`,
        );
        continue;
      }
      if (t.kind === "peer-log-react") {
        lines.push(
          `#${t.id} peer-log-react [${p.log_kind}]`,
          `  summary: ${this.truncate(p.summary, 200)}`,
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
    this.output(lines.join("\n") + "\n");
  }

  async isSessionActive(sessionId) {
    const res = await this.fetchJson(`/v1/sessions/${encodeURIComponent(sessionId)}`);
    return res?.session?.status === "active";
  }

  // process.log 注入用に、 自分のセッションが見ている repo_path を保持して
  // hook 起動間で「直近 error 行を二重に貼らない」ようにする (file-based cursor).
  cursorPath(sessionId) {
    const dir = join(homedir(), ".cache", "concordia");
    return join(dir, `proc-cursor-${sessionId.slice(0, 32)}.json`);
  }

  readCursor(sessionId) {
    const p = this.cursorPath(sessionId);
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, "utf8")) ?? {}; } catch { return {}; }
  }

  writeCursor(sessionId, map) {
    const p = this.cursorPath(sessionId);
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(map));
    } catch { /* swallow */ }
  }

  async dumpProcessLogs(sessionId) {
    // 1. このセッションの repo_path を取得
    const sess = await this.fetchJson(`/v1/sessions/${encodeURIComponent(sessionId)}`);
    const repoPath = sess?.session?.repo_path;
    if (!repoPath) return;
    // 2. その repo に紐づく processes 一覧
    const res = await this.fetchJson(`/v1/processes?repo_path=${encodeURIComponent(repoPath)}`);
    const procs = res?.processes ?? [];
    if (procs.length === 0) return;
    const cursor = this.readCursor(sessionId);
    const lines = [];
    for (const p of procs) {
      const since = Number(cursor[p.name] ?? 0);
      const lr = await this.fetchJson(
        `/v1/processes/${encodeURIComponent(p.name)}/logs?level=error&limit=20${since ? `&since_ts=${since}` : ""}`,
      );
      const logs = lr?.logs ?? [];
      if (logs.length === 0) {
        // クールド: 行が無くても running か exited か exit_code を出す (重複防止のため最初の 1 回のみ).
        if (cursor[p.name] === undefined) {
          const tag = p.live ? "running" : `exited(code=${p.exit_code ?? "?"})`;
          lines.push(`  ${p.name}: ${tag} cwd=${p.cwd}`);
          cursor[p.name] = this.nowSec();
        }
        continue;
      }
      lines.push(`  ${p.name} [${p.live ? "running" : "exited"}]: ${logs.length} 行の error`);
      for (const l of logs.slice(-5)) {
        lines.push(`    [${l.stream}] ${this.truncate(l.line, 300)}`);
      }
      const last = logs[logs.length - 1];
      cursor[p.name] = last?.ts ?? this.nowSec();
    }
    this.writeCursor(sessionId, cursor);
    if (lines.length === 0 || this.quietStdout) return;
    this.output("[Concordia process logs]\n" + lines.join("\n") + "\n");
  }

  nowSec() { return Math.floor(Date.now() / 1000); }

  truncate(s, n = 80) {
    if (typeof s !== "string") return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // ─── helpers ─────────────────────────────────────────

  safeJson(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  async postJson(path, body) {
    return this.fetchJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // backend 不達の short-circuit。 hook 1 回の起動内で fetch は直列に最大 4〜9 本
  // 走るため、 backend 停止中に各 1.5s ずつタイムアウトすると毎ターン数秒の
  // フリーズに見える。 最初の接続失敗 / timeout 以降は即 null を返して抜ける。


  async fetchJson(path, init = {}) {
    if (this.serverUnreachable) return null;
    const url = `${this.urlBase}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      this.serverUnreachable = true;
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  tryGitRemote(cwd) {
    try {
      return execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: this.gitTimeoutMs, windowsHide: true,
      }).trim() || null;
    } catch { return null; }
  }
  tryGitBranch(cwd) {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: this.gitTimeoutMs, windowsHide: true,
      }).trim() || null;
    } catch { return null; }
  }

}
