/**
 * /v1/sessions API. spec/service-schema.md §4-7 準拠.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import type { SessionRow, SessionStatus, ProviderName } from "../shared/types.js";
import type { Dispatcher } from "../dispatcher.js";
import type { PersonasRepo, PersonaRow } from "../db/personas-repo.js";
import { eventBus } from "../events.js";
import type { ProcessManager } from "../processes/manager.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import type { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import { resolveLictorTarget, fetchFromLictor } from "../control/lictor-proxy.js";
import { spawnSession } from "../control/spawner.js";
import { runSessionEndFlow } from "../control/end-session-flow.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("sessions-api");

/**
 * transcript-frame に乗ってくる user input 1 件分のログ出力上限.
 * 長文プロンプトの 1 回貼り付けが ~数 KB に達することがあるので、
 * 個人情報やシークレットを大量に流さないよう冒頭だけ残す.
 */
const PROMPT_LOG_PREVIEW_CHARS = 200;

const StartSchema = z.object({
  id: z.string().min(1).max(128),
  provider: z.enum(["claude-code", "gemini-cli", "codex-cli", "unknown"]),
  repo_path: z.string().min(1),
  repo_origin: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  host: z.string().min(1),
  transcript_path: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PatchSchema = z.object({
  current_task: z.string().optional(),
  branch: z.string().optional(),
  repo_path: z.string().min(1).optional(),
  repo_origin: z.string().nullable().optional(),
  /**
   * Shallow merge into session.metadata. Use `null` value to delete a key.
   * Lictor uses this post-spawn to publish `lictor_port` once the sidecar
   * is bound (the initial register happens BEFORE the port is known).
   */
  metadata: z.record(z.unknown()).optional(),
});

const EventSchema = z.object({
  kind: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional(),
  ts: z.number().int().positive().optional(),
});

const InjectSchema = z.object({
  text: z.string().min(1).max(4000),
  source: z.string().min(1).max(120).optional(),
});

const TranscriptFrameSchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: z.string().min(1).max(64),
  payload: z.unknown(),
});

const PermissionRequestSchema = z.object({
  request_id: z.string().min(1).max(128),
  tool_name: z.string().min(1).max(128),
  tool_input: z.unknown(),
});

const PermissionResponseSchema = z.object({
  request_id: z.string().min(1).max(128),
  decision: z.enum(["allow", "deny", "ask"]),
  reason: z.string().max(2000).optional(),
});

/**
 * Body for POST /v1/sessions/:id/title-suggestion.
 * 上限 200 char は OSC タイトルの実用幅 + 多バイト混在を考慮して広めに取る.
 * 実際の rename は Lictor 側の sanitizer (32 char cap) が決める.
 */
const TitleSuggestionSchema = z.object({
  text: z.string().min(1).max(200),
});

const ForkSchema = z.object({
  /** Claude per-message uuid to resume from. Comes from the transcript frame's payload.claude_uuid. */
  claude_uuid: z.string().min(1).max(128),
  /** Working directory for the new session. Defaults to parent's repo_path. */
  cwd: z.string().min(1).optional(),
  /** Window vs tab — passed through to wt.exe spawner. */
  mode: z.enum(["tab", "window"]).optional(),
});

export interface SessionsApiDeps {
  repo: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  config: ConcordiaConfig;
  dispatcher: Dispatcher;
  personas: PersonasRepo;
  processManager: ProcessManager;
  sessionTaskRecords: SessionTaskRecordsRepo;
  transcriptLogs: TranscriptLogsRepo;
}

function serializePersonaForResponse(p: PersonaRow) {
  let traits: unknown = [];
  let learned: unknown = [];
  try { traits = JSON.parse(p.traits); } catch { traits = []; }
  try { learned = JSON.parse(p.learned_notes); } catch { learned = []; }
  return {
    id: p.id,
    name: p.name,
    display_name: p.display_name ?? "",
    description: p.description,
    traits,
    speech_style: p.speech_style,
    skill_template: p.skill_template,
    learned_notes: learned,
  };
}

export function sessionsRouter(deps: SessionsApiDeps): Hono {
  const app = new Hono();

  // POST /v1/sessions  — start hook
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = StartSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const input = parsed.data;
    const now = nowSec();

    const existing = deps.repo.findSession(input.id);
    if (existing) {
      // 既存セッションが lost / ended なら "再開" として active 化.
      // repo_path / repo_origin / branch は cwd 移動や checkout で変わり得るので毎回上書きする.
      if (existing.status !== "active") {
        deps.repo.setStatus(input.id, "active", now);
      } else {
        deps.repo.updateHeartbeat(input.id, now);
      }
      deps.repo.patchSession(input.id, {
        repo_path: input.repo_path,
        repo_origin: input.repo_origin ?? null,
        branch: input.branch ?? undefined,
      });
    } else {
      deps.repo.insertSession({
        id: input.id,
        provider: input.provider as ProviderName,
        repo_path: input.repo_path,
        repo_origin: input.repo_origin ?? null,
        branch: input.branch ?? null,
        host: input.host,
        started_at: now,
        last_seen_at: now,
        transcript_path: input.transcript_path ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      });
      deps.repo.appendEvent({
        session_id: input.id,
        ts: now,
        kind: "start",
        payload: { provider: input.provider, host: input.host, cwd: input.repo_path, branch: input.branch ?? null },
      });
      eventBus.emit({
        type: "session.started",
        session_id: input.id,
        provider: input.provider,
        repo_path: input.repo_path,
        branch: input.branch ?? null,
        ts: now,
      });
    }

    const session = deps.repo.findSession(input.id)!;
    const peers = deps.repo.findActivePeers(input.repo_path, input.id);
    const lostCandidates = deps.repo.findLostCandidates(input.repo_path, input.host);
    const advisory = buildAdvisory(session, peers);

    // dev-process.md 由来のプロセスを auto-start (既に running なら skip).
    // FS / spawn を伴うので失敗は飲み込んで session 登録は完了させる.
    let processStartup: ReturnType<ProcessManager["startFromRepo"]> | null = null;
    try {
      processStartup = deps.processManager.startFromRepo(input.repo_path, input.repo_origin ?? null);
    } catch (err) {
      processStartup = {
        started: [],
        skipped: [],
        failed: [{ name: "*", reason: (err as Error).message }],
        warnings: [`startFromRepo error: ${(err as Error).message}`],
        marker_only: false,
        devProcessMdPath: null,
      };
    }

    // persona を排他 assign (Concordia 経由で起動された session のみ. ここを叩いた時点で確定).
    const assignment = deps.personas.assign(input.id);
    if (assignment && !assignment.reused) {
      // 新規 assign なら role_label を session metadata に反映 (UI / dispatcher 共有用).
      const meta = parseMeta(session.metadata);
      meta.role_label = assignment.persona.name;
      meta.persona_id = assignment.persona.id;
      deps.repo.setMetadata(input.id, JSON.stringify(meta));
      eventBus.emit({
        type: "persona.assigned",
        session_id: input.id,
        persona_id: assignment.persona.id,
        persona_name: assignment.persona.name,
        ts: nowSec(),
      });
    }

    return c.json({
      session: serializeSession(deps.repo.findSession(input.id)!),
      peers: peers.map(serializeSession),
      lost_candidates: lostCandidates.map(serializeSession),
      advisory,
      persona: assignment ? serializePersonaForResponse(assignment.persona) : null,
      persona_reused: assignment ? assignment.reused : false,
      processes: processStartup,
      process_stream_url: `ws://127.0.0.1:${deps.config.port}/ws`,
    });
  });

  // GET /v1/sessions
  app.get("/", (c) => {
    const q = c.req.query();
    const list = deps.repo.listSessions({
      repo_origin: q.repo_origin || undefined,
      host: q.host || undefined,
      status: (q.status as SessionStatus) || undefined,
      provider: (q.provider as ProviderName) || undefined,
    });
    return c.json({ sessions: list.map(serializeSession) });
  });

  // GET /v1/sessions/:id
  app.get("/:id", (c) => {
    const s = deps.repo.findSession(c.req.param("id"));
    if (!s) return c.json({ error: "not_found" }, 404);
    const events = deps.repo.recentEvents(s.id, 200);
    // persona (active assignment があれば) を同梱. statusline / UI が 1 リクエストで
    // ロール名 + 人物名を取れるように.
    const assignment = deps.personas.findActiveBySession(s.id);
    const persona = assignment ? deps.personas.find(assignment.persona_id) : null;
    return c.json({
      session: serializeSession(s),
      persona: persona ? serializePersonaForResponse(persona) : null,
      events: events.map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        payload: safeParse(e.payload),
      })),
    });
  });

  // PATCH /v1/sessions/:id
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    // Split off `metadata` — patchSession() only handles the column fields.
    const { metadata, ...columnPatch } = parsed.data;
    deps.repo.patchSession(id, columnPatch);
    if (metadata) deps.repo.mergeMetadata(id, metadata);
    deps.repo.updateHeartbeat(id, nowSec());
    if (parsed.data.current_task !== undefined) {
      deps.repo.appendEvent({
        session_id: id,
        ts: nowSec(),
        kind: "task_update",
        payload: { current_task: parsed.data.current_task },
      });
    }
    return c.json({ ok: true });
  });

  // POST /v1/sessions/:id/heartbeat
  app.post("/:id/heartbeat", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    deps.repo.updateHeartbeat(id, nowSec());
    return c.json({ ok: true });
  });

  // GET /v1/sessions/:id/tasks  — このセッションの TodoWrite 記録一覧.
  // task_update event がくるたびに upsert された session_task_records を返す.
  // - remaining: status !== "completed" の行 (= 残作業)
  // - completed: completed_at セット済みの行 (= 処理済み + 担当者)
  app.get("/:id/tasks", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const items = deps.sessionTaskRecords.listBySession(id);
    const remaining = items.filter((t) => t.status !== "completed");
    const completed = items.filter((t) => t.completed_at !== null);
    const counts = deps.sessionTaskRecords.countBySessionStatus(id);
    return c.json({ items, remaining, completed, counts });
  });

  // GET /v1/sessions/:id/pending-tasks  — hook が pull
  app.get("/:id/pending-tasks", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const list = deps.tasks.pull(id, 20);
    return c.json({
      tasks: list.map((t) => ({
        id: t.id,
        kind: t.kind,
        payload: safeParse(t.payload),
        created_at: t.created_at,
        delivered_at: t.delivered_at,
      })),
    });
  });

  // POST /v1/sessions/:id/event
  app.post("/:id/event", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = EventSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ts = parsed.data.ts ?? nowSec();
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: parsed.data.kind,
      payload: parsed.data.payload ?? {},
    });
    deps.repo.updateHeartbeat(id, ts);
    // prompt event は「いま何してるか」の最有力 signal なので current_task に反映
    if (parsed.data.kind === "prompt") {
      const summary = (parsed.data.payload as { summary?: unknown } | undefined)?.summary;
      if (typeof summary === "string" && summary.trim().length > 0) {
        deps.repo.patchSession(id, { current_task: summary.trim().slice(0, 200) });
      }
    }
    // task_update event は TodoWrite の状態遷移. session_task_records へ
    // upsert して残作業 / 完了 / 担当者 を per-task で記録.
    if (parsed.data.kind === "task_update") {
      const todos = (parsed.data.payload as { todos?: unknown } | undefined)?.todos;
      if (Array.isArray(todos)) {
        deps.sessionTaskRecords.applyTaskUpdate({
          session_id: id,
          todos: todos as Array<{ content?: unknown; activeForm?: unknown; status?: unknown }>,
          nowSec: ts,
        });
      }
    }
    const session = deps.repo.findSession(id)!;
    const eventCount = deps.repo.countEvents(id);
    deps.dispatcher.onEventAppended(session, eventCount);
    eventBus.emit({ type: "session.event", session_id: id, kind: parsed.data.kind, ts });
    return c.json({ ok: true });
  });

  // POST /v1/sessions/:id/permission-request — Lictor's PreToolUse hook
  // is blocked waiting for a user decision. Emit a session-targeted event
  // so the Web UI modal shows up. We do NOT persist or block here — the
  // pending state lives in Lictor's sidecar (it has the resolver).
  app.post("/:id/permission-request", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PermissionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    eventBus.emit({
      type: "session.permission_request",
      target_session_id: id,
      request_id: parsed.data.request_id,
      tool_name: parsed.data.tool_name,
      tool_input: parsed.data.tool_input,
      ts: nowSec(),
    });
    return c.json({ ok: true });
  });

  // POST /v1/sessions/:id/permission-response — Web UI's modal answer.
  // Proxied to Lictor's sidecar /v1/internal/permission-response, which
  // resolves the pending PreToolUse hook. Returns Lictor's status verbatim
  // so the Web UI can surface "session not running" / "already resolved" /
  // etc. when the response arrives too late.
  app.post("/:id/permission-response", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = PermissionResponseSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const target = resolveLictorTarget(deps.repo, id);
    if ("error" in target) return c.json({ error: target.error }, 404);
    let upstream: Response;
    try {
      upstream = await fetchFromLictor(target.port, "/v1/internal/permission-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
    } catch (err) {
      return c.json({ error: `lictor unreachable: ${(err as Error).message}` }, 502);
    }
    const text = await upstream.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return c.json(json as Record<string, unknown>, upstream.status as 200);
  });

    // POST /v1/sessions/:id/title-suggestion — session AI が repo_change_watcher
    // 由来 title-suggest task に対して 30 文字以内のサマリを投稿する.
    // 受信した text をそのまま Lictor /v1/rename に転送 → OSC タイトル更新.
    // pending task は (delivered/undelivered 問わず) markResponded で retry 対象から外す.
  app.post("/:id/title-suggestion", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = TitleSuggestionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const target = resolveLictorTarget(deps.repo, id);
    if ("error" in target) return c.json({ error: target.error }, 404);
    let upstream: Response;
    try {
      upstream = await fetchFromLictor(target.port, "/v1/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: parsed.data.text }),
      });
    } catch (err) {
      return c.json({ error: `lictor unreachable: ${(err as Error).message}` }, 502);
    }
    // 応答済 title-suggest を retry 対象から外す.
    deps.tasks.markResponded(id, ["title-suggest"]);
    const text = await upstream.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return c.json(
      { ok: upstream.ok, lictor: json as Record<string, unknown> },
      upstream.status as 200,
    );
  });

  // POST /v1/sessions/:id/transcript-frame — Lictor relays one parsed
  // line from Claude/Codex session JSONL.
  //
  // v0.5: per-session transcript_logs テーブルに永続化する. これで session 終了後も
  // 会話・tool 履歴を後追いできる (本来 session_events feed の S/N を壊さないために
  // 別 table に分離). UNIQUE(session_id, seq) で重複 POST は安全に no-op.
  // 加えて従来通り `transcript.frame` event を eventBus に流し、 Web UI が WS で
  // 受け取れるようにする.
  app.post("/:id/transcript-frame", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = TranscriptFrameSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ts = nowSec();

    // 永続化: 失敗してもログ流通は止めず、 続けて WS broadcast に進む
    // (永続化失敗は dispatcher / 監視への副作用が無いため安全)
    let persisted = false;
    try {
      persisted = deps.transcriptLogs.insert({
        session_id: id,
        seq: parsed.data.seq,
        ts,
        kind: parsed.data.kind,
        payload: parsed.data.payload,
      });
    } catch (err) {
      log.warn(
        { session_id: id, seq: parsed.data.seq, err: (err as Error).message },
        "transcript_logs insert failed; falling back to WS-only broadcast",
      );
    }

    // ユーザ指示テキスト (kind="text" + payload.role="user") を構造化ログに残す.
    // Lictor → Concordia 転送経路の「いま何を頼まれて動いているか」 を後追いできるようにする目的.
    if (parsed.data.kind === "text") {
      const p = parsed.data.payload as { role?: unknown; text?: unknown } | null;
      if (p && p.role === "user" && typeof p.text === "string") {
        const fullLen = p.text.length;
        const preview = p.text.length > PROMPT_LOG_PREVIEW_CHARS
          ? p.text.slice(0, PROMPT_LOG_PREVIEW_CHARS) + "…"
          : p.text;
        log.info(
          { session_id: id, seq: parsed.data.seq, length: fullLen, text: preview },
          "user prompt forwarded via transcript",
        );
      }
    }
    eventBus.emit({
      type: "transcript.frame",
      target_session_id: id,
      seq: parsed.data.seq,
      kind: parsed.data.kind,
      payload: parsed.data.payload,
      ts,
    });
    return c.json({ ok: true, persisted });
  });

  // GET /v1/sessions/:id/transcript — 永続化された transcript_logs を読む.
  // クエリ:
  //   - since_id  : 指定 id より新しい行だけ返す (incremental tail)
  //   - limit     : 1..1000 (default 200)
  // 並び順は ts ASC + seq ASC (chronological).
  app.get("/:id/transcript", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const q = c.req.query();
    const sinceId = q.since_id ? Number(q.since_id) : undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    const entries = deps.transcriptLogs.listBySession(id, {
      since_id: Number.isFinite(sinceId) ? sinceId : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    const total = deps.transcriptLogs.countBySession(id);
    return c.json({
      session_id: id,
      total,
      entries,
      // 連続 pull したい client 向けに、 次回 since_id に使える highest id を返す.
      next_since_id: entries.length > 0 ? entries[entries.length - 1].id : sinceId ?? 0,
    });
  });

  // POST /v1/sessions/:id/fork — spawn a new lictor session that resumes
  // claude from a specific message uuid (the fork anchor). Used by the
  // Web UI's per-transcript-frame "fork from here" button.
  //
  // The new session registers with Concordia via its own POST /v1/sessions
  // call (lictor does this at startup). We don't try to pre-link the
  // parent here — the spawn → register handshake is async and the new
  // session's id isn't known yet. After register, the fork.requested event
  // (recorded in this session's events) provides the audit trail.
  app.post("/:id/fork", async (c) => {
    const id = c.req.param("id");
    const parent = deps.repo.findSession(id);
    if (!parent) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = ForkSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const cwd = parsed.data.cwd ?? parent.repo_path;
    const mode = parsed.data.mode ?? "tab";
    const result = spawnSession({
      provider: "claude",
      mode,
      cwd,
      args: ["--resume", parsed.data.claude_uuid],
      title: `fork:${parent.id.slice(0, 8)}@${parsed.data.claude_uuid.slice(0, 8)}`,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    // Audit trail on the parent — same kind as inject so the timeline
    // shows what spun out of this conversation.
    deps.repo.appendEvent({
      session_id: id,
      ts: nowSec(),
      kind: "fork_requested",
      payload: {
        claude_uuid: parsed.data.claude_uuid,
        cwd,
        mode,
        pid: result.pid,
      },
    });
    return c.json({ ok: true, pid: result.pid, command: result.command });
  });

  // POST /v1/sessions/:id/inject  — push an instruction to the wrapped TUI.
  //
  // GET /v1/sessions/:id/fs/{read|list|grep}
  // Proxies to Lictor's /v1/fs/* with the same query string. Lictor enforces
  // cwd-confinement; Concordia just forwards. 404 when the session has no
  // Lictor sidecar (not running, never wrapped, or pre-lictor v0.4.2).
  app.get("/:id/fs/read", async (c) => {
    const target = resolveLictorTarget(deps.repo, c.req.param("id"));
    if ("error" in target) return c.json({ error: target.error }, 404);
    return proxyGet(c, target.port, `/v1/fs/read?${c.req.url.split("?")[1] ?? ""}`);
  });
  app.get("/:id/fs/list", async (c) => {
    const target = resolveLictorTarget(deps.repo, c.req.param("id"));
    if ("error" in target) return c.json({ error: target.error }, 404);
    return proxyGet(c, target.port, `/v1/fs/list?${c.req.url.split("?")[1] ?? ""}`);
  });
  app.get("/:id/fs/grep", async (c) => {
    const target = resolveLictorTarget(deps.repo, c.req.param("id"));
    if ("error" in target) return c.json({ error: target.error }, 404);
    return proxyGet(c, target.port, `/v1/fs/grep?${c.req.url.split("?")[1] ?? ""}`);
  });

  // Emits a `session.inject` event over the WS bus, scoped (via WS broadcast
  // filtering) to the WS client whose ?session=<id> matches. Lictor's WS
  // handler receives it and writes the sanitized text + \r to its pty, so it
  // arrives in the wrapped claude as if the user typed it.
  //
  // The session must be active and have an open WS (otherwise the message
  // hits no recipient and is silently dropped). We return 200 either way —
  // delivery confirmation is the caller's problem; the contract is "enqueue
  // for delivery to the session's WS bus".
  app.post("/:id/inject", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = InjectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ts = nowSec();
    eventBus.emit({
      type: "session.inject",
      target_session_id: id,
      text: parsed.data.text,
      source: parsed.data.source ?? null,
      ts,
    });
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "inject",
      payload: { text: parsed.data.text, source: parsed.data.source ?? null },
    });
    return c.json({ ok: true, ts });
  });

  // POST /v1/sessions/:id/resume
  app.post("/:id/resume", async (c) => {
    const oldId = c.req.param("id");
    const old = deps.repo.findSession(oldId);
    if (!old) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const newId = body?.new_session_id;
    if (typeof newId !== "string") return c.json({ error: "new_session_id required" }, 400);
    const next = deps.repo.findSession(newId);
    if (next) {
      deps.repo.patchSession(newId, {
        current_task: old.current_task ?? undefined,
        branch: old.branch ?? undefined,
      });
    }
    deps.repo.setStatus(old.id, "abandoned", nowSec(), nowSec());
    deps.repo.appendEvent({
      session_id: old.id,
      ts: nowSec(),
      kind: "note",
      payload: { resumed_by: newId },
    });
    return c.json({ ok: true, old: serializeSession(old), new: next ? serializeSession(next) : null });
  });

  // POST /v1/sessions/:id/abandon
  app.post("/:id/abandon", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    deps.repo.setStatus(id, "abandoned", nowSec(), nowSec());
    return c.json({ ok: true });
  });

  // DELETE /v1/sessions/:id  — end + 独立した per-session report 生成 (claude CLI narrative)
  // session-end フロー (report 生成 / 独白投稿 / persona release) は control/end-session-flow.ts に
  // 集約済. ここでは status 遷移と end event の append だけ行い、 残りは helper に委譲する.
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const s = deps.repo.findSession(id);
    if (!s) return c.json({ error: "not_found" }, 404);
    const now = nowSec();
    deps.repo.setStatus(id, "ended", now, now);
    deps.repo.appendEvent({
      session_id: id,
      ts: now,
      kind: "end",
      payload: { duration_sec: now - s.started_at },
    });
    const ended = deps.repo.findSession(id)!;
    const { report } = await runSessionEndFlow(
      {
        repo: deps.repo,
        chat: deps.chat,
        dispatcher: deps.dispatcher,
        personas: deps.personas,
        config: deps.config,
      },
      ended,
    );
    return c.json({ ok: true, session: serializeSession(ended), report });
  });

  return app;
}

function buildAdvisory(session: SessionRow, peers: SessionRow[]) {
  const sameBranchPeers = peers.filter((p) => p.branch && p.branch === session.branch);
  const branchConflict = sameBranchPeers.length > 0;
  const shortId = session.id.slice(0, 8);
  const repoBase = session.repo_path.split(/[/\\]/).pop() ?? "repo";
  const worktreeCommand = branchConflict
    ? `git worktree add ../${repoBase}-${shortId} ${session.branch ?? "HEAD"}`
    : null;
  return {
    active_peer_count: peers.length,
    active_peer_ids: peers.map((p) => p.id),
    branch_conflict: branchConflict,
    recommend_worktree: branchConflict,
    worktree_command: worktreeCommand,
  };
}

export function serializeSession(s: SessionRow) {
  return {
    id: s.id,
    provider: s.provider,
    repo_path: s.repo_path,
    repo_origin: s.repo_origin,
    branch: s.branch,
    host: s.host,
    started_at: s.started_at,
    ended_at: s.ended_at,
    status: s.status,
    last_seen_at: s.last_seen_at,
    current_task: s.current_task,
    metadata: s.metadata ? safeParse(s.metadata) : null,
  };
}

async function proxyGet(c: { json: (body: any, status: any) => Response }, port: number, path: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetchFromLictor(port, path, { method: "GET" });
  } catch (err) {
    return c.json({ error: `lictor unreachable: ${(err as Error).message}` }, 502 as 502);
  }
  const text = await upstream.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return c.json(body, upstream.status as 200);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function parseMeta(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
