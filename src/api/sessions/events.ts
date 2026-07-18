import type { Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, reviveIfLost, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";

export function registerEventsRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.get("/:id/tasks", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const items = deps.sessionTaskRecords.listBySession(id);
    const remaining = items.filter((t) => t.status !== "completed");
    const completed = items.filter((t) => t.completed_at !== null);
    const counts = deps.sessionTaskRecords.countBySessionStatus(id);
    return c.json({ items, remaining, completed, counts });
  });

app.get("/:id/pending-tasks", (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    // Lictor はこの endpoint を短間隔でポーリングするので、通常の /event 投稿が
    // 途絶えている無入力中セッションでも heartbeat が更新される (= 誤って lost 判定
    // されない) ようにここでも updateHeartbeat する。
    if (session.status === "active") deps.repo.updateHeartbeat(id, nowSec());
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

app.post("/:id/event", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
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
    reviveIfLost(deps.repo, session, ts);
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
    eventBus.emit({ type: "session.event", session_id: id, kind: parsed.data.kind, ts });
    return c.json({ ok: true });
  });
}
