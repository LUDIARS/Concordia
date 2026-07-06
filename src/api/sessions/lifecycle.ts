import type { Hono } from "hono";
import type { ProcessManager } from "../../processes/manager.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { findConflictPeers } from "../../control/conflict-scope.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, runSessionEndFlow, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, emitAutoSessionEndInject, pickSessionEndInjectText, AUTO_SESSION_END_INJECT_SOURCE, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, SESSION_END_DONE_TIMEOUT_MS, pendingSessionEndExits, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, serializePersonaForResponse, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";

export function registerLifecycleRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = StartSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const input = parsed.data;
    const now = nowSec();
    // /co-relictor 由来の新セッションなら、 cwd 一致で引き継ぎ資料を claim して後段で inject する。
    let relictorHandoff: string | null = null;

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
        target_project: input.target_project ?? undefined,
      });
    } else {
      // delegation spawn 由来なら、 spawn 時に記録した (cwd, emoji) を repo_path で
      // claim してテンプレ絵文字を metadata へ焼く (Slack ライブカードの先頭アイコン)。
      const claimed = claimPendingDelegationSpawn(input.repo_path);
      const meta: Record<string, unknown> = { ...(input.metadata ?? {}) };
      if (claimed?.emoji) meta.delegation_emoji = claimed.emoji;
      if (claimed?.callName) meta.delegation_call_name = claimed.callName;
      if (claimed?.runId) meta.delegation_run_id = claimed.runId;
      // 子会社由来の spawn は subsidiary_id を焼く。 子会社 Bot はこれで自分のセッションを
      // 判別し (subsidiary-only 可視)、 本社 Bot は subsidiary_id 付きを写さない。
      if (claimed?.subsidiaryId) meta.subsidiary_id = claimed.subsidiaryId;
      // project 限定 spawn は project を焼く (作業範囲の監査 / UI 表示用)。
      if (claimed?.project) meta.project = claimed.project;
      // /co-relictor 再起動の引き継ぎ: cwd 一致で claim し、 旧ゴールを metadata へ引き継ぐ。
      // handoff 本文は後段で inject する。
      const relictor = claimPendingRelictor(input.repo_path);
      if (relictor) {
        relictorHandoff = relictor.handoff;
        if (relictor.goal) meta.goal = relictor.goal;
      }
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
        target_project: input.target_project ?? null,
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
    // 衝突 peer は repo_path 直束ねではなく target_project 宣言 + root 除外を考慮した
    // conflict-scope で判定する (umbrella ルート cwd の相互ノイズを排除)。
    const peers = findConflictPeers(
      session,
      deps.repo.listSessions({ status: "active" }),
      deps.resolveWorkspaceRoots?.() ?? [],
    );
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
    const assignment = (deps.resolvePersonaInjectEnabled?.() ?? false)
      ? deps.personas.assign(input.id)
      : null;
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
    const contextPacket = buildCollaborationContextPacket({
      repo: deps.repo,
      session: freshSession,
      workspaceRoots: deps.resolveWorkspaceRoots?.() ?? [],
      ccWorkflowEnabled: deps.resolveCcWorkflowEnabled?.() ?? false,
    });

    // /co-relictor 再起動なら、引き継ぎ資料だけを inject して文脈を復元する。
    if (relictorHandoff) {
      const handoffText = `${RELICTOR_REINJECT_HEADER}${relictorHandoff}`;
      deps.repo.appendEvent({
        session_id: input.id,
        ts: nowSec(),
        kind: "inject",
        payload: { text: handoffText, source: RELICTOR_INJECT_SOURCE },
      });
      setTimeout(() => {
        eventBus.emit({
          type: "session.inject",
          target_session_id: input.id,
          text: handoffText,
          source: RELICTOR_INJECT_SOURCE,
          ts: nowSec(),
        });
      }, 1500).unref?.();
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
      goal: readGoalFromMetadata(freshSession.metadata),
      context_packet: contextPacket,
    });
  });

app.get("/", (c) => {
    const q = c.req.query();
    const subsidiaryId = (q.subsidiary_id ?? "").trim();
    const list = deps.repo.listSessions({
      repo_origin: q.repo_origin || undefined,
      host: q.host || undefined,
      status: (q.status as SessionStatus) || undefined,
      provider: (q.provider as ProviderName) || undefined,
      subsidiary_id: subsidiaryId || undefined,
    });
    return c.json({ sessions: list.map(serializeSession) });
  });

app.get("/:id/context", (c) => {
    const id = c.req.param("id");
    const s = deps.repo.findSession(id);
    if (!s) return c.json({ error: "not_found" }, 404);
    return c.json({
      context_packet: buildCollaborationContextPacket({
        repo: deps.repo,
        session: s,
        workspaceRoots: deps.resolveWorkspaceRoots?.() ?? [],
        ccWorkflowEnabled: deps.resolveCcWorkflowEnabled?.() ?? false,
      }),
    });
  });

app.get("/:id", (c) => {
    const id = c.req.param("id");
    const s = deps.repo.findSession(id);
    if (!s) {
      // session 行が purge 済みでも transcript が残っていれば、 ログ閲覧用に
      // synthetic session を返す (詳細ページが描画でき transcript パネルが読める).
      const span = deps.transcriptLogs.tsSpan(id);
      if (span) {
        return c.json({ session: syntheticPurgedSession(id, span), persona: null, events: [] });
      }
      return c.json({ error: "not_found" }, 404);
    }
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

app.post("/:id/heartbeat", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    deps.repo.updateHeartbeat(id, nowSec());
    return c.json({ ok: true });
  });

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

app.post("/:id/abandon", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findSession(id)) return c.json({ error: "not_found" }, 404);
    deps.repo.setStatus(id, "abandoned", nowSec(), nowSec());
    return c.json({ ok: true });
  });

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
        harnessAudit: deps.harnessAudit,
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
}
