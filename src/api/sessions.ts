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
import { applySessionEndFeedback } from "../personas/feedback.js";
import { aggregateBullets, generateReport } from "../report/generator.js";
import { eventBus } from "../events.js";
import type { ProcessManager } from "../processes/manager.js";

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

export interface SessionsApiDeps {
  repo: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  config: ConcordiaConfig;
  dispatcher: Dispatcher;
  personas: PersonasRepo;
  processManager: ProcessManager;
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
    const session = deps.repo.findSession(id)!;
    const eventCount = deps.repo.countEvents(id);
    deps.dispatcher.onEventAppended(session, eventCount);
    eventBus.emit({ type: "session.event", session_id: id, kind: parsed.data.kind, ts });
    return c.json({ ok: true });
  });

  // POST /v1/sessions/:id/inject  — push an instruction to the wrapped TUI.
  //
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
    const events = deps.repo.allEvents(id);
    const ended = deps.repo.findSession(id)!;
    const bullets = aggregateBullets(ended, events);
    deps.dispatcher.onSessionEnd(ended, bullets);

    // 独立した per-session report を生成 (claude CLI で narrative)
    const report = await generateReport(ended, events, {
      apiKey: deps.config.anthropicApiKey,
      model: deps.config.reportModel,
    });
    deps.repo.upsertReport(report);

    // report の冒頭ポエム (独白) を #報告 channel に投稿し、 他 AI セッションの reply を促す.
    const monologue = extractMonologue(report.summary_md);
    if (monologue) {
      const role = parseSessionRole(ended);
      const msg = deps.chat.insert({
        channel: "報告",
        session_id: id,
        author_label: role,
        text: monologue,
        in_reply_to: null,
        is_actionable: false,
        metadata: JSON.stringify({ from_report: true, session_id: id }),
      });
      // dispatcher 経由で他 active session に chat-reply task をばらまく
      deps.dispatcher.onChatPosted({
        id: msg.id,
        channel: msg.channel,
        session_id: msg.session_id,
        text: msg.text,
        author_label: msg.author_label,
        is_actionable: false,
      });
      eventBus.emit({
        type: "chat.posted",
        message_id: msg.id,
        channel: msg.channel,
        author_label: msg.author_label,
        ts: msg.ts,
        is_actionable: false,
      });
    }

    eventBus.emit({ type: "session.ended", session_id: id, ts: now });
    eventBus.emit({ type: "report.generated", session_id: id, ts: now });

    // persona feedback + release. assignment が無ければ no-op.
    const assignment = deps.personas.findActiveBySession(id);
    if (assignment) {
      const persona = deps.personas.find(assignment.persona_id);
      if (persona) {
        // feedback 生成は claude CLI を呼ぶので非同期、 結果を待たず先に release する
        // (release を待ってる間に他 session に同 persona が assign されないよう、 await する).
        await applySessionEndFeedback({ personas: deps.personas, chat: deps.chat }, ended, persona);
      }
      deps.personas.release(id);
      eventBus.emit({
        type: "persona.released",
        session_id: id,
        persona_id: assignment.persona_id,
        ts: now,
      });
    }

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

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * report の summary_md から「独白」 (冒頭の poem 部分) を抽出.
 * 3 セクション構造 (poem / "---" / 業務報告 / "---" / サマリ) を前提に、
 * 最初の "---" より前を返す. 失敗したら null.
 */
function extractMonologue(summaryMd: string): string | null {
  const sep = summaryMd.indexOf("\n---");
  if (sep <= 0) return null;
  const head = summaryMd.slice(0, sep).trim();
  if (head.length < 10 || head.length > 1500) return null;
  return head;
}

function parseMeta(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function parseSessionRole(s: SessionRow): string {
  if (!s.metadata) return "雑用係";
  try {
    const m = JSON.parse(s.metadata) as { role_label?: string };
    return m.role_label ?? "雑用係";
  } catch { return "雑用係"; }
}
