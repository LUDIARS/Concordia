import type { Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";
import { isSessionEndPending, SESSION_END_PENDING_AT_KEY, stopCompletedSessionProcesses } from "../../control/session-end-process.js";

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

app.post("/:id/relictor", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    if (session.status !== "active") return c.json({ error: `session is ${session.status}` }, 400);
    const sp = toSpawnProvider(session.provider);
    if (!sp) return c.json({ error: `provider ${session.provider} is not spawnable` }, 400);
    // lictor_port が無いと force-exit できない (= Lictor ラップでない)。 spawn 自体は可能だが
    // 旧セッションを確実に畳めないので拒否する。
    const target = resolveLictorTarget(deps.repo, id);
    if ("error" in target) return c.json({ error: `not lictor-wrapped: ${target.error}` }, 400);

    // 1) 引き継ぎ資料を生成しチャンネルへ投稿 (durable ログ)。
    const recent = collectRecentContext(deps.transcriptLogs, id);
    const handoff = await generateHandoff({ runClaude, log }, session.current_task ?? "", recent);
    const io = makeCompactionIO({ sessions: deps.repo, chat: deps.chat });
    try {
      await io.postHandoff(id, `🔁 **再起動引き継ぎ資料 (relictor)**\n\n${handoff}`);
    } catch (e) {
      log.warn({ session_id: id, err: (e as Error).message }, "relictor: handoff post failed");
    }

    // 2) cwd キーで handoff + goal を記録 (新セッション登録時に claim される)。
    recordPendingRelictor({ cwd: session.repo_path, handoff, goal: readGoalFromMetadata(session.metadata) });

    // 3) 新セッションを spawn (最新 Lictor dist を junction 経由で拾う)。
    const result = spawnSession({
      provider: sp,
      cwd: session.repo_path,
      mode: "tab",
      title: session.current_task ?? undefined,
    });
    if (!result.ok) {
      return c.json({ error: `spawn failed: ${result.error}` }, 500);
    }

    // 4) 旧セッションを ended 化 + force-exit (runSessionEndFlow は回さない=再起動なので軽量に畳む)。
    const now = nowSec();
    deps.repo.setStatus(id, "ended", now, now);
    deps.repo.appendEvent({ session_id: id, ts: now, kind: "end", payload: { reason: "relictor", duration_sec: now - session.started_at } });
    eventBus.emit({ type: "session.ended", session_id: id, ts: now });
    void fetchFromLictor(target.port, "/v1/internal/force-exit", { method: "POST" }).catch(() => {});
    // 保険: force-exit は Windows/ConPTY で不発になりやすい。 猶予後に生存していれば確定 kill。
    const lictorPid = parseLictorPid(session.metadata);
    if (lictorPid != null) {
      setTimeout(() => {
        if (isPidAlive(lictorPid)) void stopSessionByLictorPid(lictorPid);
      }, FORCE_EXIT_GRACE_MS).unref?.();
    }
    log.info({ session_id: id, repo: session.repo_path }, "relictor: spawned replacement + ended old");
    return c.json({ ok: true, spawn: result.command });
  });

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
