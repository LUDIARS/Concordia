import type { Context, Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, forgetPendingRelictorBySpawnId, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";
import { isSessionEndPending, SESSION_END_PENDING_AT_KEY, stopCompletedSessionProcesses } from "../../control/session-end-process.js";
import { wireSessionSuccessionService } from "../../control/succession/session-succession-wiring.js";
import type { SuccessionResult } from "../../control/succession/session-succession-service.js";

export function registerEndRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.post("/:id/compact", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    const io = makeCompactionIO({ sessions: deps.repo, chat: deps.chat });
    const result = await runCompaction(
      { sessions: deps.repo, transcriptLogs: deps.transcriptLogs, runClaude, ...io },
      id,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  // relictor / handover の機構は SessionSuccessionService に一本化した (自動引き継ぎ監視と共有)。
  // route は HTTP 変換だけを担う (spec/feature/session-auto-succession.md §2.2)。
  const succession = deps.succession ?? wireSessionSuccessionService({
    sessions: deps.repo,
    chat: deps.chat,
    transcriptLogs: deps.transcriptLogs,
    controlJobs: deps.controlJobs,
    runClaude,
    toSpawnProvider,
    forceExitGraceMs: FORCE_EXIT_GRACE_MS,
    log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
  });
  const respond = (c: Context, result: SuccessionResult) =>
    result.ok ? c.json({ ok: true, spawn: result.spawnCommand }) : c.json({ error: result.error }, result.status);

  app.post("/:id/relictor", async (c) => respond(c, await succession.relictor(c.req.param("id"))));

  /**
   * POST /:id/handover — このセッションの作業を次のセッションへ移行する。 handoff はセッション
   * 自身に書かせ、 捕捉に失敗したら切り離し生成へフォールバックする。
   */
  app.post("/:id/handover", async (c) => respond(c, await succession.handover(c.req.param("id"))));

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

app.post("/:id/session-end-done", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    if (!isSessionEndPending(session.metadata)) {
      return c.json({ ok: true, ignored: true, reason: "session-end not pending" });
    }
    const stop = await stopCompletedSessionProcesses(session.metadata);
    if (!stop.ok) {
      log.warn({ session_id: id, failed: stop.failed }, "session-end completed but process stop failed");
      return c.json({ ok: false, error: "process_stop_failed", stop }, 500);
    }
    deps.repo.mergeMetadata(id, { [SESSION_END_PENDING_AT_KEY]: null });
    if (session.status === "lost") deps.repo.setStatus(id, "ended", nowSec(), nowSec());
    log.info({ session_id: id, stopped: stop.stopped, already_stopped: stop.alreadyStopped }, "session-end completed — processes stopped");
    return c.json({ ok: true, stop });
  });
}
