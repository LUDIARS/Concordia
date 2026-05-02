/**
 * /v1/sessions API. spec/service-schema.md §4-7 準拠.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import type { SessionRow, SessionStatus, ProviderName } from "../shared/types.js";
import type { Dispatcher } from "../dispatcher.js";
import { aggregateBullets, generateReport } from "../report/generator.js";

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
});

const EventSchema = z.object({
  kind: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional(),
  ts: z.number().int().positive().optional(),
});

export interface SessionsApiDeps {
  repo: SessionsRepo;
  tasks: TasksRepo;
  config: ConcordiaConfig;
  dispatcher: Dispatcher;
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
      // 既存セッションが lost / ended なら "再開" として last_seen_at と status のみ active 化
      if (existing.status !== "active") {
        deps.repo.setStatus(input.id, "active", now);
      } else {
        deps.repo.updateHeartbeat(input.id, now);
      }
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
    }

    const session = deps.repo.findSession(input.id)!;
    const peers = deps.repo.findActivePeers(input.repo_origin ?? null, input.id);
    const lostCandidates = deps.repo.findLostCandidates(input.repo_origin ?? null, input.host);
    const advisory = buildAdvisory(session, peers);

    return c.json({
      session: serializeSession(session),
      peers: peers.map(serializeSession),
      lost_candidates: lostCandidates.map(serializeSession),
      advisory,
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
    return c.json({
      session: serializeSession(s),
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
    deps.repo.patchSession(id, parsed.data);
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
    const session = deps.repo.findSession(id)!;
    const eventCount = deps.repo.countEvents(id);
    deps.dispatcher.onEventAppended(session, eventCount);
    return c.json({ ok: true });
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

  // DELETE /v1/sessions/:id  — end + report
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
    const report = await generateReport(ended, events, {
      apiKey: deps.config.anthropicApiKey,
      model: deps.config.reportModel,
    });
    deps.repo.upsertReport(report);
    const bullets = aggregateBullets(ended, events);
    deps.dispatcher.onSessionEnd(ended, bullets);
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
