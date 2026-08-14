import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, forgetPendingRelictorBySpawnId, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";
import { isSessionEndPending, SESSION_END_PENDING_AT_KEY, stopCompletedSessionProcesses } from "../../control/session-end-process.js";
import { buildSessionHandoverPrompt, elicitHandoffFromSession } from "../../control/compaction.js";
import { ENTER_KEY_TEXT } from "../../control/enter-key.js";

export function registerEndRoutes(app: Hono, deps: SessionsApiDeps): void {
  const successionInProgress = new Set<string>();
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

/**
   * relictor / handover 共通の後段 — 引き継ぎを spawn ID で登録 → 後継セッションを
   * spawn → 旧セッションを ended 化 + force-exit (+保険 kill)。 handoff の作り方だけが
   * 両者の違いなので、 それ以外の機構をここに一本化する。
   */
  const spawnSuccessorAndEndSession = (
    c: Context,
    input: {
      id: string;
      session: NonNullable<ReturnType<typeof deps.repo.findSession>>;
      spawnProvider: NonNullable<ReturnType<typeof toSpawnProvider>>;
      lictorPort: number;
      handoff: string;
      kind: "relictor" | "handover";
    },
  ) => {
    const { id, session, spawnProvider, handoff, kind } = input;
    const spawnId = randomUUID();

    // SessionStart は enrollment ID で claim する。cwd だけでは並行 spawn を区別できない。
    recordPendingRelictor({
      cwd: session.repo_path,
      spawnId,
      handoff,
      goal: readGoalFromMetadata(session.metadata),
      kind,
    });

    // 後継セッションを spawn (relictor は最新 Lictor dist を junction 経由で拾う)。
    const result = spawnSession({
      provider: spawnProvider,
      cwd: session.repo_path,
      mode: "tab",
      title: session.current_task ?? undefined,
      spawnId,
    });
    if (!result.ok) {
      forgetPendingRelictorBySpawnId(spawnId);
      return c.json({ error: `spawn failed: ${result.error}` }, 500);
    }

    // 旧セッションを ended 化 + force-exit (runSessionEndFlow は回さない = 移行なので軽量に畳む)。
    const now = nowSec();
    deps.repo.setStatus(id, "ended", now, now);
    deps.repo.appendEvent({ session_id: id, ts: now, kind: "end", payload: { reason: kind, duration_sec: now - session.started_at } });
    eventBus.emit({ type: "session.ended", session_id: id, ts: now });
    void fetchFromLictor(input.lictorPort, "/v1/internal/force-exit", { method: "POST" }).catch(() => {
      // 旧 Lictor が先に終了して接続が切れることがある。保険 kill が後段で確認するため best-effort。
    });
    // 保険: force-exit は Windows/ConPTY で不発になりやすい。 猶予後に生存していれば確定 kill。
    const lictorPid = parseLictorPid(session.metadata);
    if (lictorPid != null) {
      setTimeout(() => {
        if (isPidAlive(lictorPid)) {
          try {
            const job = deps.controlJobs.enqueueStopProcess({
              pid: lictorPid,
              source: `${kind}-insurance`,
              sessionId: id,
              role: "lictor",
              expectedCommand: null,
            });
            log.info({ session_id: id, pid: lictorPid, job_id: job.id }, `${kind} insurance kill queued`);
          } catch (error) {
            log.warn({ session_id: id, pid: lictorPid, error }, `${kind} insurance kill enqueue failed`);
          }
        }
      }, FORCE_EXIT_GRACE_MS).unref?.();
    }
    log.info({ session_id: id, repo: session.repo_path }, `${kind}: spawned successor + ended old`);
    return c.json({ ok: true, spawn: result.command });
  };

  /** relictor / handover 共通の前提検査。 満たさなければ理由付きで 4xx を返す。 */
  const requireSuccessionTarget = (c: Context, id: string) => {
    const session = deps.repo.findSession(id);
    if (!session) return { response: c.json({ error: "not_found" }, 404) } as const;
    if (session.status !== "active") return { response: c.json({ error: `session is ${session.status}` }, 400) } as const;
    const spawnProvider = toSpawnProvider(session.provider);
    if (!spawnProvider) {
      return { response: c.json({ error: `provider ${session.provider} is not spawnable` }, 400) } as const;
    }
    // lictor_port が無いと force-exit できない (= Lictor ラップでない)。 spawn 自体は可能だが
    // 旧セッションを確実に畳めないので拒否する。
    const target = resolveLictorTarget(deps.repo, id);
    if ("error" in target) return { response: c.json({ error: `not lictor-wrapped: ${target.error}` }, 400) } as const;
    return { session, spawnProvider, lictorPort: target.port } as const;
  };

  app.post("/:id/relictor", async (c) => {
    const id = c.req.param("id");
    const checked = requireSuccessionTarget(c, id);
    if ("response" in checked) return checked.response;
    if (successionInProgress.has(id)) return c.json({ error: "session succession already in progress" }, 409);
    successionInProgress.add(id);
    const { session, spawnProvider, lictorPort } = checked;

    try {
      // 引き継ぎ資料を切り離し生成しチャンネルへ投稿 (durable ログ)。
      const recent = collectRecentContext(deps.transcriptLogs, id);
      const handoff = await generateHandoff({ runClaude, log }, session.current_task ?? "", recent);
      const io = makeCompactionIO({ sessions: deps.repo, chat: deps.chat });
      try {
        await io.postHandoff(id, `🔁 **再起動引き継ぎ資料 (relictor)**\n\n${handoff}`);
      } catch (e) {
        log.warn({ session_id: id, err: (e as Error).message }, "relictor: handoff post failed");
      }

      return spawnSuccessorAndEndSession(c, {
        id, session, spawnProvider, lictorPort, handoff, kind: "relictor",
      });
    } finally {
      successionInProgress.delete(id);
    }
  });

/**
   * POST /:id/handover — このセッションの作業を **次のセッションへ移行** する
   * (自動引き継ぎ)。 relictor と同じ「spawn → 旧セッション終了 → 新セッションへ
   * handoff inject」の機構を使うが、 handoff は **セッション自身に書かせる**
   * (compaction と同じ session-end 相当の自筆。 実作業を行った当人がフルコンテキストで
   * 書くため、 計画/実状の乖離が起きない)。 捕捉に失敗したら切り離し生成へフォールバック。
   */
  app.post("/:id/handover", async (c) => {
    const id = c.req.param("id");
    const checked = requireSuccessionTarget(c, id);
    if ("response" in checked) return checked.response;
    if (successionInProgress.has(id)) return c.json({ error: "session succession already in progress" }, 409);
    successionInProgress.add(id);
    const { session, spawnProvider, lictorPort } = checked;

    try {
      const io = makeCompactionIO({ sessions: deps.repo, chat: deps.chat });
      const plainLog = {
        info: (m: string) => log.info(m),
        warn: (m: string) => log.warn(m),
      };

      // 1) handoff はセッション自身に書かせる (session-end 相当の自筆)。
      let handoff = "";
      let watermark = 0;
      try {
        watermark = deps.transcriptLogs.maxId(id);
      } catch (e) {
        log.warn({ session_id: id, err: (e as Error).message }, "handover: watermark 取得失敗");
      }
      const askedOk = await io.inject(
        id,
        buildSessionHandoverPrompt(session.current_task ?? ""),
        "handover-handoff-request",
      );
      await io.inject(id, ENTER_KEY_TEXT, "handover-handoff-request-enter");
      if (askedOk) {
        const captured = await elicitHandoffFromSession(
          { transcriptLogs: deps.transcriptLogs, log: plainLog },
          id,
          watermark,
        );
        if (captured) handoff = captured;
      }

      // フォールバック (無言で空にしない): 捕捉失敗時は切り離し生成に切替える。
      if (!handoff) {
        log.warn({ session_id: id }, "handover: セッション自筆 handoff の捕捉失敗 → 切り離し生成にフォールバック");
        const recent = collectRecentContext(deps.transcriptLogs, id);
        handoff = await generateHandoff({ runClaude, log }, session.current_task ?? "", recent);
      }

      // 2) チャンネルへ投稿 (durable ログ)。 失敗しても移行は続行するが警告。
      try {
        await io.postHandoff(id, `🤝 **次セッション引き継ぎ資料 (handover)**\n\n${handoff}`);
      } catch (e) {
        log.warn({ session_id: id, err: (e as Error).message }, "handover: handoff post failed");
      }

      return spawnSuccessorAndEndSession(c, {
        id, session, spawnProvider, lictorPort, handoff, kind: "handover",
      });
    } finally {
      successionInProgress.delete(id);
    }
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
