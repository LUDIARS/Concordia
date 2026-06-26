/**
 * /v1/sessions API. spec/service-schema.md §4-7 準拠.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ParticipantsRepo } from "../db/participants-repo.js";
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
import {
  parsePendingQuestionOptions,
  type DiscordPendingQuestionsRepo,
  type DiscordSessionChannelsRepo,
  type DiscordConfigRepo,
} from "../db/discord-repo.js";
import { resolveLictorTarget, fetchFromLictor } from "../control/lictor-proxy.js";
import { spawnSession } from "../control/spawner.js";
import { claimPendingDelegationSpawn } from "../control/pending-delegation-spawns.js";
import { runSessionEndFlow } from "../control/end-session-flow.js";
import { stopSessionByLictorPid, isPidAlive } from "../control/stop-session.js";
import { parseLictorPid, parseAgentClientPid } from "../control/reaper.js";
import {
  emitAutoSessionEndInject,
  pickSessionEndInjectText,
  AUTO_SESSION_END_INJECT_SOURCE,
} from "../control/auto-session-end-inject.js";
import { createChildLogger } from "../shared/logger.js";
import {
  INITIAL_WORK_QUESTION,
  INITIAL_WORK_INJECT_SOURCE,
  buildInitialWorkInjectText,
  buildInitialWorkOptions,
  formatDevelopmentTitle,
  markInitialWorkQuestionAsked,
  maybeParseInitialWorkTarget,
} from "../control/initial-work.js";

const log = createChildLogger("sessions-api");

/**
 * transcript-frame に乗ってくる user input 1 件分のログ出力上限.
 * 長文プロンプトの 1 回貼り付けが ~数 KB に達することがあるので、
 * 個人情報やシークレットを大量に流さないよう冒頭だけ残す.
 */
const PROMPT_LOG_PREVIEW_CHARS = 200;
/** DELETE 後 force-exit の猶予。 これを過ぎても lictor_pid 生存なら強制 kill する。 */
const FORCE_EXIT_GRACE_MS = 5000;
/**
 * AI 側の session-end スキルが完了シグナルを送るまで force-exit を保留する猶予。
 * `POST /v1/sessions/:id/session-end-done` が来ればその時点で即 force-exit。
 * 来なくてもこの時間後に保険として force-exit を発行する。
 */
const SESSION_END_DONE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
/** id → force-exit 実行関数。 session-end-done シグナルかタイムアウトで発火する。 */
const pendingSessionEndExits = new Map<string, () => void>();

const StartSchema = z.object({
  id: z.string().min(1).max(128),
  provider: z.enum(["claude-code", "gemini-cli", "codex-cli", "local-llm", "unknown"]),
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
  // 人間入力者の表示名 (ingress が付与)。参加者レジストリ登録 + ミラー発言者明示に使う。
  author_label: z.string().min(1).max(120).optional(),
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
// /:id/title 用 (window-title hook / rename コマンドから。Lictor へは転送しない)。
const TitleSetSchema = z.object({
  text: z.string().min(1).max(200),
});
// AskUserQuestion option は旧形式 string と新形式 {label, description?} の
// 両方を受け入れる. 内部 (DB / Discord embed) では正規化された {label, description?} で扱う.
const PendingQuestionOptionSchema = z.union([
  z.string().min(1).max(80),
  z.object({
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(200).optional(),
  }),
]);
const PendingQuestionSchema = z.object({
  question: z.string().min(1).max(2000),
  options: z.array(PendingQuestionOptionSchema).min(1).max(25),
  multi_select: z.boolean().optional(),
});
// 回答は 3 形態のいずれか: 単一 (answer_index) / 複数 (answer_indices) / 自由文 (other_text)。
const AnswerQuestionSchema = z
  .object({
    question_id: z.number().int().positive(),
    answer_index: z.number().int().min(0).max(24).optional(),
    answer_indices: z.array(z.number().int().min(0).max(24)).min(1).max(25).optional(),
    other_text: z.string().min(1).max(2000).optional(),
  })
  .refine(
    (d) => d.answer_index !== undefined || d.answer_indices !== undefined || d.other_text !== undefined,
    { message: "one of answer_index / answer_indices / other_text required" },
  );

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
  pendingQuestions: DiscordPendingQuestionsRepo;
  discordChannels: DiscordSessionChannelsRepo;
  discordConfig: DiscordConfigRepo;
  participants: ParticipantsRepo;
  resolveWorkspaceRoots?: () => string[];
}

/** discord_config に保存される meta channel の key (resolveMetaKind と揃える). */
const META_CHANNEL_KINDS = ["chitchat", "consultation", "houkoku", "system"] as const;

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
      // delegation spawn 由来なら、 spawn 時に記録した (cwd, emoji) を repo_path で
      // claim してテンプレ絵文字を metadata へ焼く (Slack ライブカードの先頭アイコン)。
      const claimed = claimPendingDelegationSpawn(input.repo_path);
      const meta: Record<string, unknown> = { ...(input.metadata ?? {}) };
      if (claimed?.emoji) meta.delegation_emoji = claimed.emoji;
      if (claimed?.callName) meta.delegation_call_name = claimed.callName;
      // 子会社由来の spawn は subsidiary_id を焼く。 子会社 Bot はこれで自分のセッションを
      // 判別し (subsidiary-only 可視)、 本社 Bot は subsidiary_id 付きを写さない。
      if (claimed?.subsidiaryId) meta.subsidiary_id = claimed.subsidiaryId;
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
        metadata: Object.keys(meta).length ? JSON.stringify(meta) : null,
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

    const freshSession = deps.repo.findSession(input.id)!;
    const initialWorkOptions = await buildInitialWorkOptions(
      deps.repo,
      freshSession,
      deps.resolveWorkspaceRoots?.() ?? [input.repo_path],
    );
    const initialWorkQuestion = markInitialWorkQuestionAsked(deps.pendingQuestions, freshSession, initialWorkOptions);
    if (!initialWorkQuestion.deduped) {
      const ts = nowSec();
      deps.repo.appendEvent({
        session_id: input.id,
        ts,
        kind: "pending_question",
        payload: {
          question_id: initialWorkQuestion.questionId,
          question: INITIAL_WORK_QUESTION,
          options: initialWorkOptions,
          initial_work: true,
        },
      });
      setTimeout(() => {
        eventBus.emit({
          type: "question.posted",
          target_session_id: input.id,
          question_id: initialWorkQuestion.questionId,
          question: INITIAL_WORK_QUESTION,
          options: initialWorkOptions,
          ts,
        });
      }, 500).unref?.();
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
      initial_work: {
        question_id: initialWorkQuestion.questionId,
        question: INITIAL_WORK_QUESTION,
        options: initialWorkOptions,
      },
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

  // POST /v1/sessions/:id/title — セッションのタイトル(やる事)を設定し title_renamed を
  // emit するだけ。Lictor /v1/rename には転送しない(= claude TUI に /rename を打ち込まない)
  // ので、window-title hook から毎回叩いても自セッションに slash 注入しない。
  // Discord は title_renamed で channel rename + status card 更新、Slack は thread root 反映。
  app.post("/:id/title", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = TitleSetSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const now = nowSec();
    // current_task も更新する。 Discord は title_renamed の payload からタイトルを読むが、
    // Slack ライブカードは session.current_task を読むため、 ここを書かないと rename が
    // Slack カードに反映されない (📌 がセッション id 先頭8桁のまま固まる)。
    deps.repo.patchSession(id, { current_task: parsed.data.text.slice(0, 200) });
    deps.repo.appendEvent({ session_id: id, ts: now, kind: "title_renamed", payload: { text: parsed.data.text } });
    eventBus.emit({ type: "session.event", session_id: id, kind: "title_renamed", ts: now });
    return c.json({ ok: true, ts: now });
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
    const now = nowSec();
    deps.repo.appendEvent({
      session_id: id,
      ts: now,
      kind: "title_renamed",
      // source: "title-suggestion" を付与し、Discord bot 側でチャンネル名リネームを抑制する。
      // AI の自動タイトル提案はチャンネル名に反映せず topic のみ更新する。
      payload: { text: parsed.data.text, source: "title-suggestion" },
    });
    eventBus.emit({ type: "session.event", session_id: id, kind: "title_renamed", ts: now });
    const text = await upstream.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return c.json(
      { ok: upstream.ok, lictor: json as Record<string, unknown> },
      upstream.status as 200,
    );
  });

  app.post("/:id/pending-question", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PendingQuestionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ts = nowSec();
    // 冪等化: 同一 session で同じ question 文の行が既にあれば、 重複投稿せず
    // その question_id をそのまま返す。 AskUserQuestion は picker-open 時 (Lictor の
    // PreToolUse hook) と transcript-tail (回答後) の 2 経路から POST され得るため、
    // 2 度目は Discord カードを増やさず既存に収束させる (resolve は同一 qid で成立)。
    //   - 未回答行: picker が開いている間の再 POST を弾く。
    //   - 最近回答済行: 早期投稿→回答後に transcript-tail が遅れて再 POST してくる
    //     ケースを弾く。 これが無いと「回答したのに未回答カードが新規に生える」事故になる
    //     (回答は既に確定しているのに重複カードのせいで未送信に見える)。
    const existing =
      deps.pendingQuestions.findUnansweredByQuestion(id, parsed.data.question) ??
      deps.pendingQuestions.findRecentlyAnsweredByQuestion(id, parsed.data.question, ts - 600);
    if (existing) {
      return c.json({ ok: true, question_id: existing.id, ts: existing.ts, deduped: true });
    }
    const row = deps.pendingQuestions.insert({
      session_id: id,
      question: parsed.data.question,
      options: parsed.data.options,
      multiSelect: parsed.data.multi_select === true,
    });
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "pending_question",
      payload: {
        question_id: row.id,
        question: row.question,
        options: parsed.data.options,
        multi_select: parsed.data.multi_select === true,
      },
    });
    eventBus.emit({
      type: "question.posted",
      target_session_id: id,
      question_id: row.id,
      question: row.question,
      options: parsed.data.options,
      multi_select: parsed.data.multi_select === true,
      ts,
    });
    return c.json({ ok: true, question_id: row.id, ts });
  });

  app.post("/:id/answer-question", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = AnswerQuestionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const row = deps.pendingQuestions.findById(parsed.data.question_id);
    if (!row || row.session_id !== id) return c.json({ error: "not_found" }, 404);
    if (row.answered_at !== null) return c.json({ error: "already_answered" }, 409);
    const options = parsePendingQuestionOptions(row.options_json);

    // 回答 3 形態を answer_text に正規化する (Lictor はこの text をそのまま pty へ注入):
    //   - other_text : 自由文をそのまま
    //   - answer_indices : 各 label を ", " 結合 (複数選択)
    //   - answer_index : 単一 label
    let answerText: string;
    let answerIndex = -1; // picker fallback 用 (Other は -1)
    if (parsed.data.other_text !== undefined) {
      answerText = parsed.data.other_text;
      deps.pendingQuestions.markAnsweredOther(row.id, answerText);
    } else if (parsed.data.answer_indices !== undefined) {
      const idxs = parsed.data.answer_indices;
      const labels = idxs.map((i) => options[i]?.label);
      if (labels.some((l) => !l)) return c.json({ error: "answer_index_out_of_range" }, 400);
      answerText = labels.join(", ");
      answerIndex = idxs[0];
      deps.pendingQuestions.markAnsweredMulti(row.id, idxs, answerText);
    } else {
      const single = parsed.data.answer_index!;
      const label = options[single]?.label;
      if (!label) return c.json({ error: "answer_index_out_of_range" }, 400);
      answerText = label;
      answerIndex = single;
      deps.pendingQuestions.markAnswered(row.id, single, answerText);
    }

    const ts = nowSec();
    eventBus.emit({
      type: "question.answered",
      target_session_id: id,
      question_id: row.id,
      answer_index: answerIndex,
      answer_text: answerText,
      ts,
    });
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "question_answered",
      payload: { question_id: row.id, answer_index: answerIndex, answer_text: answerText },
    });
    const session = deps.repo.findSession(id)!;
    const initialTarget = maybeParseInitialWorkTarget(row.question, answerText, session);
    if (initialTarget) {
      const title = formatDevelopmentTitle(initialTarget);
      deps.repo.patchSession(id, {
        branch: initialTarget.branch,
        current_task: title.slice(0, 200),
      });
      deps.repo.mergeMetadata(id, {
        initial_work_target: initialTarget,
        initial_work_confirmed_at: ts,
      });
      deps.repo.appendEvent({
        session_id: id,
        ts,
        kind: "title_renamed",
        payload: { text: title, reason: "initial_work_selected" },
      });
      eventBus.emit({ type: "session.event", session_id: id, kind: "title_renamed", ts });

      // 開発対象が確定したら、 残タスク取得 → 一覧提示 → 実行可否の問い合わせ を
      // session AI に促す指示を text inject する。 回答経路 (Discord/Slack) に依らず
      // 同じ流れに揃え、 「Discord は無反応 / Slack は勝手に着手」 の挙動割れを解消する。
      // question.answered 由来の picker キーストローク fallback が先に pty へ届くので、
      // 少し遅延させて空プロンプトに指示が綺麗に入るようにする (question.posted と同じ手当て)。
      const injectText = buildInitialWorkInjectText(initialTarget);
      deps.repo.appendEvent({
        session_id: id,
        ts,
        kind: "inject",
        payload: { text: injectText, source: INITIAL_WORK_INJECT_SOURCE },
      });
      setTimeout(() => {
        eventBus.emit({
          type: "session.inject",
          target_session_id: id,
          text: injectText,
          source: INITIAL_WORK_INJECT_SOURCE,
          ts: nowSec(),
        });
      }, 800).unref?.();
    }
    return c.json({ ok: true, answer_text: answerText });
  });

  // picker がローカル（端末キーボード）で回答され解決したことを Lictor が通知する。
  // answered_at を立てて以後の answer-question / ボタン押下を弾き（stray 注入防止）、
  // question.resolved を emit して Discord/Slack 側のボタンを除去させる。idempotent。
  app.post("/:id/pending-question/:qid/resolve", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const qid = Number(c.req.param("qid"));
    if (!Number.isInteger(qid)) return c.json({ error: "invalid_qid" }, 400);
    const row = deps.pendingQuestions.findById(qid);
    if (!row || row.session_id !== id) return c.json({ error: "not_found" }, 404);
    if (row.answered_at !== null) return c.json({ ok: true, already: true });
    deps.pendingQuestions.markResolvedLocally(row.id);
    const ts = nowSec();
    eventBus.emit({ type: "question.resolved", target_session_id: id, question_id: row.id, ts });
    deps.repo.appendEvent({ session_id: id, ts, kind: "question_resolved", payload: { question_id: row.id } });
    return c.json({ ok: true });
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

  // GET /v1/sessions/:id/discord-channels — Lictor が自分の session channel ID +
  // meta channel ID 群を取得する (spec/discord-lictor-relay.md §4.1)。
  // Lictor はこれを保持して以後の relay に discord_channel_id をタグ付けし、
  // egress の session→channel DB ルックアップ依存 (混線の温床) を外す。
  // channel 作成は session.started event 経由で非同期なので、 未作成時は
  // session_channel_id=null を返す (Lictor 側がリトライで埋める)。
  app.get("/:id/discord-channels", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const row = deps.discordChannels.findBySessionId(id);
    const cfg = deps.discordConfig.all();
    const meta: Record<string, string | null> = {};
    for (const k of META_CHANNEL_KINDS) {
      meta[k] = cfg[`${k}_channel_id`] ?? null;
    }
    return c.json({
      ok: true,
      session_channel_id: row?.channel_id ?? null,
      session_channel_status: row?.status ?? null,
      meta_channels: meta,
    });
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
    const src = parsed.data.source ?? null;
    // 人間メッセージ (source="discord:<uid>:…" / "slack:<uid>:…") なら入力者を
    // participants レジストリに登録し、発言者名を session.inject に載せて
    // 相手プラットフォームのミラーで「誰の発言か」を出せるようにする。
    // /enter 等の制御 inject (source 例 "discord-enter") はコロン区切りでないため除外。
    let authorLabel: string | null = null;
    if (src && parsed.data.author_label) {
      const m = /^(discord|slack):([^:]+)/.exec(src);
      if (m) {
        const row = deps.participants.upsert({
          platform: m[1] as "discord" | "slack",
          platform_user_id: m[2],
          display_name: parsed.data.author_label,
        });
        authorLabel = row.display_name;
      }
    }
    eventBus.emit({
      type: "session.inject",
      target_session_id: id,
      text: parsed.data.text,
      source: src,
      author_label: authorLabel,
      ts,
    });
    deps.repo.appendEvent({
      session_id: id,
      ts,
      kind: "inject",
      payload: { text: parsed.data.text, source: src },
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

  // POST /v1/sessions/:id/request-stat — Web UI から「いま stat を投げて」 と
  // 手動依頼する. AI に stat-collect task を 1 件 enqueue する.
  // dedup: 未配信 stat-collect が既にあれば 200 で no-op を返す.
  app.post("/:id/request-stat", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    if (deps.tasks.hasUndelivered(id, "stat-collect")) {
      return c.json({ ok: true, enqueued: false, reason: "already_pending" });
    }
    deps.tasks.enqueue({
      session_id: id,
      kind: "stat-collect",
      payload: {
        trigger: "manual",
        instructions:
          "Web UI から手動依頼です. 現在の作業現況を JSON で集計し " +
          "POST http://127.0.0.1:11111/v1/stat/<self_id> に投稿してください. " +
          "本文 body は `{ \"payload\": { ... } }`. " +
          "payload に含めるキー (どれも任意): active_repos / open_prs / unmerged_branches / todos_summary / recent_work / note.",
      },
    });
    return c.json({ ok: true, enqueued: true });
  });

  // POST /v1/sessions/:id/request-title — Web UI から「いま rename して」 と
  // 手動依頼する. AI に title-suggest task を 1 件 enqueue する.
  app.post("/:id/request-title", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    if (deps.tasks.hasUndelivered(id, "title-suggest")) {
      return c.json({ ok: true, enqueued: false, reason: "already_pending" });
    }
    deps.tasks.enqueue({
      session_id: id,
      kind: "title-suggest",
      payload: {
        reason: "manual",
        instructions:
          "Web UI から手動依頼です. 現在の作業を 30 文字以内 (日本語可、 OSC タイトル向け) " +
          `で 1 行に要約して POST http://127.0.0.1:11111/v1/sessions/${id}/title-suggestion ` +
          "に { \"text\": \"<タイトル文字列>\" } で投稿してください. " +
          "Concordia 側が Lictor の /v1/rename に転送します.",
      },
    });
    return c.json({ ok: true, enqueued: true });
  });

  // DELETE /v1/sessions/:id  — end + 独立した per-session report 生成 (claude CLI narrative)
  // session-end フロー (report 生成 / 独白投稿 / persona release) は control/end-session-flow.ts に
  // 集約済. ここでは status 遷移と end event の append だけ行い、 残りは helper に委譲する.
  //
  // status を ended にする前に、 wrapped AI セッションに `/session-end` 実行を促す
  // inject を emit する (Discord `/end-session` 経由でも自動で発火するように).
  // status=active のうちに event を投げる必要がある (Lictor の onInject は WS
  // broadcast 経由で provider-別 submit を行うため、 status 確認は Lictor 側
  // で行わないが、 概念上 active なセッションへの inject であることが重要).
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const s = deps.repo.findSession(id);
    if (!s) return c.json({ error: "not_found" }, 404);
    const now = nowSec();
    // fire-and-forget: Lictor WS が無い / failure でも report 生成は続行
    try {
      const injected = emitAutoSessionEndInject(s);
      if (injected) {
        deps.repo.appendEvent({
          session_id: id,
          ts: now,
          kind: "inject",
          payload: {
            text: pickSessionEndInjectText(s.provider),
            source: AUTO_SESSION_END_INJECT_SOURCE,
            reason: "auto on DELETE /v1/sessions/:id",
          },
        });
      }
    } catch { /* swallow — best effort */ }
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
    // force-exit は AI 側の session-end スキル完了後に発行する。
    // `POST /v1/sessions/:id/session-end-done` が来た時点で即 force-exit、
    // シグナルなし時は SESSION_END_DONE_TIMEOUT_MS 後に保険として発行する。
    // これにより session-log 出力・memory 更新・残タスク登録が完了する前に
    // WT ウインドウが閉じる問題を防ぐ。
    const lictorPid = parseLictorPid(ended.metadata);
    const agentClientPid = parseAgentClientPid(ended.metadata);
    const doForceExit = () => {
      pendingSessionEndExits.delete(id);
      const lictorTarget = resolveLictorTarget(deps.repo, id);
      if (!("error" in lictorTarget)) {
        void fetchFromLictor(lictorTarget.port, "/v1/internal/force-exit", { method: "POST" })
          .catch(() => {});
      }
      // 保険: force-exit は Windows/ConPTY で不発になりやすい (graceful 終了に失敗するとプロセスが残る)。
      // 猶予後に lictor_pid / agent_client_pid がまだ生きていれば確定的に kill する (taskkill /F /T)。
      // agent-client は通常 WS の session.ended で自死するが、 WS 切断中だとイベントを取りこぼすため pid で保険。
      if (lictorPid != null || agentClientPid != null) {
        setTimeout(() => {
          if (lictorPid != null && isPidAlive(lictorPid)) {
            const r = stopSessionByLictorPid(lictorPid);
            if (!r.ok) log.warn({ session_id: id, pid: lictorPid, error: r.error }, "delete insurance kill failed");
            else log.info({ session_id: id, pid: lictorPid }, "delete insurance kill (force-exit did not terminate lictor)");
          }
          if (agentClientPid != null && isPidAlive(agentClientPid)) {
            const r = stopSessionByLictorPid(agentClientPid);
            if (!r.ok) log.warn({ session_id: id, pid: agentClientPid, error: r.error }, "delete agent-client kill failed");
            else log.info({ session_id: id, pid: agentClientPid }, "delete agent-client kill (WS self-shutdown missed)");
          }
        }, FORCE_EXIT_GRACE_MS).unref?.();
      }
    };
    const exitTimer = setTimeout(() => {
      log.info({ session_id: id }, "session-end-done timeout — forcing exit");
      doForceExit();
    }, SESSION_END_DONE_TIMEOUT_MS);
    exitTimer.unref?.();
    pendingSessionEndExits.set(id, () => {
      clearTimeout(exitTimer);
      doForceExit();
    });
    return c.json({ ok: true, session: serializeSession(ended), report });
  });

  // AI session-end スキルが全処理 (session-log/memory 更新/残タスク登録/report append)
  // を完了した直後に呼ぶ。 Concordia はこれを受けて即座に force-exit を発行し WT を閉じる。
  // シグナルなしでも SESSION_END_DONE_TIMEOUT_MS 後に自動 force-exit するので必須ではないが、
  // 呼ぶことでターミナルが素早く閉じる。
  app.post("/:id/session-end-done", (c) => {
    const id = c.req.param("id");
    const trigger = pendingSessionEndExits.get(id);
    if (trigger) {
      log.info({ session_id: id }, "session-end-done received — triggering force-exit");
      trigger();
    }
    return c.json({ ok: true });
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
