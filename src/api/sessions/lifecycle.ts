import type { Hono } from "hono";
import { existsSync } from "node:fs";
import type { ProcessManager } from "../../processes/manager.js";
import type { DelegationRunRow } from "../../db/delegation-repo.js";
import type { ProviderName, SessionStatus } from "../../shared/types.js";
import type { SessionsApiDeps } from "./deps.js";
import { findConflictPeers } from "../../control/conflict-scope.js";
import { clampListLimit, clampListOffset } from "../../db/list-limit.js";
import { withSlimMetadata } from "./metadata-slim.js";
import {
  buildSessionWorkPolicy,
  isCastraSessionBinding,
  isWorkspaceRootCwd,
  SESSION_WORK_POLICY_SOURCE,
  WORKSPACE_ROOT_METADATA_KEY,
} from "../../control/session-work-policy.js";
import { eventBus, runCompaction, makeCompactionIO, collectRecentContext, generateHandoff, runClaude, resolveLictorTarget, fetchFromLictor, spawnSession, claimPendingDelegationSpawn, recordPendingRelictor, claimPendingRelictor, stopSessionByLictorPid, isPidAlive, parseLictorPid, parseAgentClientPid, lastHumanRequester, prefixRequesterTag, parseGoalInput, readGoalFromMetadata, mergeGoalIntoMetadata, buildCollaborationContextPacket, parseInjectSource, log, PROMPT_LOG_PREVIEW_CHARS, FORCE_EXIT_GRACE_MS, RELICTOR_INJECT_SOURCE, RELICTOR_REINJECT_HEADER, HANDOVER_INJECT_SOURCE, HANDOVER_REINJECT_HEADER, StartSchema, PatchSchema, EventSchema, InjectSchema, GoalSchema, TranscriptFrameSchema, PermissionRequestSchema, PermissionResponseSchema, TitleSuggestionSchema, TitleSetSchema, PendingQuestionSchema, AnswerQuestionSchema, ForkSchema, toSpawnProvider, buildAdvisory, serializeSession, syntheticPurgedSession, proxyGet, nowSec, reviveIfLost, logInactiveTranscriptPost, safeParse, parseMeta } from "./runtime.js";
import { endSessionNow } from "../../control/end-session-command.js";
import { resolveDelegationRunIdForSession } from "../../delegation/coordination.js";
import { emitDelegationRunChanged } from "../../delegation/run-events.js";
import { projectDelegationSessionLinks } from "../../delegation/session-links.js";
import { createProjectResolver } from "../../projects/project-resolver.js";
import { renderCcWorkflowStartupInject } from "../../control/collaboration-context.js";
import type { EscalationDeclaration } from "../../control/escalation-workflow.js";

/**
 * 開いている escalation_event を文脈パケット用の宣言へ落とす。
 * 解除済み / 未宣言なら null = 通常ワークフロー (spec/feature/escalation-mode.md §3)。
 */
function toEscalationDeclaration(deps: SessionsApiDeps, sessionId: string): EscalationDeclaration | null {
  const open = deps.escalations?.findOpen(sessionId);
  if (!open) return null;
  return { reason: open.reason, started_at: open.started_at, actor: open.actor };
}
import { BLANK_SESSION_TASK } from "../../shared/session-task.js";

export function registerLifecycleRoutes(app: Hono, deps: SessionsApiDeps): void {
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = StartSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const input = parsed.data;
    const workspaceRoots = deps.resolveWorkspaceRoots?.() ?? [];
    const projectResolver = createProjectResolver(deps.projectCodes?.list() ?? []);
    // Cross-repo investigation may start at Castra, but it is an umbrella and
    // never an implementation binding. Remember that origin so a later child
    // worktree claim is not overwritten by root-derived Lictor updates.
    const now = nowSec();
    // /co-relictor・/co-handover 由来の新セッションなら、 cwd 一致で引き継ぎ資料を claim して後段で inject する。
    let relictorHandoff: string | null = null;
    let relictorKind: "relictor" | "handover" = "relictor";
    // 全ての新規 Session に共通の fail-closed 作業ポリシーを 1 回だけ inject する。
    let sessionWorkPolicyText: string | null = null;

    const existing = deps.repo.findSession(input.id);
    const resumed = !!existing && existing.status !== "active";
    if (existing) {
      const preserveWorkingRepo = Boolean(
        isWorkspaceRootCwd(input.repo_path, workspaceRoots)
        && !isWorkspaceRootCwd(existing.repo_path, workspaceRoots)
        && isCastraSessionBinding({
          repoPath: existing.repo_path,
          targetProject: existing.target_project,
          metadata: existing.metadata,
        }, workspaceRoots),
      );
      const branchChanged = !preserveWorkingRepo
        && input.branch != null
        && existing.branch !== input.branch;
      // 既存セッションが lost / ended なら "再開" として active 化.
      // repo_path / repo_origin / branch は cwd 移動や checkout で変わり得る。
      // ただし Castra root からの再報告は既存の child binding を上書きしない。
      if (existing.status !== "active") {
        deps.repo.setStatus(input.id, "active", now);
      } else {
        deps.repo.updateHeartbeat(input.id, now);
      }
      deps.repo.patchSession(input.id, {
        repo_path: preserveWorkingRepo ? undefined : input.repo_path,
        repo_origin: preserveWorkingRepo ? undefined : input.repo_origin ?? null,
        branch: preserveWorkingRepo ? undefined : input.branch ?? undefined,
        target_project: preserveWorkingRepo ? undefined : input.target_project ?? undefined,
        active_repos: preserveWorkingRepo ? undefined : input.active_repos ?? undefined,
      });
      if (branchChanged) {
        eventBus.emit({ type: "session.event", session_id: input.id, kind: "branch_changed", ts: now });
      }
      if (resumed) {
        eventBus.emit({
          type: "session.started",
          session_id: input.id,
          provider: input.provider,
          repo_path: preserveWorkingRepo ? existing.repo_path : input.repo_path,
          branch: preserveWorkingRepo ? existing.branch : input.branch ?? existing.branch,
          ts: now,
        });
      }
    } else {
      // delegation spawn 由来なら、 spawn 時に記録した (cwd, emoji) を repo_path で
      // claim してテンプレ絵文字を metadata へ焼く (Slack ライブカードの先頭アイコン)。
      const meta: Record<string, unknown> = { ...(input.metadata ?? {}) };
      let claimedDelegationRun: DelegationRunRow | null = null;
      if (isWorkspaceRootCwd(input.repo_path, workspaceRoots)) {
        meta[WORKSPACE_ROOT_METADATA_KEY] = input.repo_path;
      }
      const rawSpawnId = typeof meta.concordia_spawn_id === "string" ? meta.concordia_spawn_id : null;
      const spawnId = rawSpawnId?.trim() || null;
      // An explicitly supplied blank enrollment value must not degrade into the
      // legacy cwd-only claim path. Treat it as malformed/consumed fail-closed.
      if (rawSpawnId !== null && spawnId === null) {
        return c.json({ error: "invalid_or_consumed_session_enrollment" }, 401);
      }
      const claimed = claimPendingDelegationSpawn(input.repo_path, Date.now(), spawnId);
      const successor = claimPendingRelictor(input.repo_path, Date.now(), spawnId);
      // concordia_spawn_id is a one-time enrollment secret placed only in the
      // spawned Lictor environment. Supplying an unknown or already-consumed
      // value is never allowed to degrade into an unowned registration. A
      // relictor/handover successor owns a separate pending enrollment.
      if (spawnId && !claimed && !successor) {
        return c.json({ error: "invalid_or_consumed_session_enrollment" }, 401);
      }
      const workPolicy = buildSessionWorkPolicy({
        repoPath: input.repo_path,
        observedBranch: input.branch ?? null,
        pendingSpawn: claimed,
        workspaceRoots,
      });
      sessionWorkPolicyText = workPolicy.text;
      const claimedProjectTarget = claimed?.project
        ? projectResolver.targetFromText(claimed.project)
        : null;
      if (claimed?.branch) meta.requested_branch = claimed.branch;
      if (workPolicy.branchMismatch) {
        meta.branch_mismatch = {
          requested: claimed?.branch ?? null,
          observed: input.branch ?? null,
        };
      }
      if (claimed?.emoji) meta.delegation_emoji = claimed.emoji;
      if (claimed?.callName) meta.delegation_call_name = claimed.callName;
      const delegationRunId = resolveDelegationRunIdForSession({
        metadataRunId: meta.delegation_run_id,
        pendingRunId: claimed?.runId ?? null,
      });
      if (delegationRunId) {
        meta.delegation_run_id = delegationRunId;
        const claimedRun = deps.delegation?.claimChildSession(delegationRunId, input.id) ?? null;
        claimedDelegationRun = claimedRun;
        if (claimedRun?.call_name) meta.delegation_call_name = claimedRun.call_name;
        const parentSessionId = claimedRun?.parent_session_id ?? claimed?.parentSessionId ?? null;
        if (parentSessionId) {
          meta.delegation_parent_session_id = parentSessionId;
          emitDelegationRunChanged(claimedRun);
        }
      } else if (claimed?.parentSessionId) {
        meta.delegation_parent_session_id = claimed.parentSessionId;
      }
      // 子会社由来の spawn は subsidiary_id を焼く。 子会社 Bot はこれで自分のセッションを
      // 判別し (subsidiary-only 可視)、 本社 Bot は subsidiary_id 付きを写さない。
      if (claimed?.subsidiaryId) meta.subsidiary_id = claimed.subsidiaryId;
      // project 限定 spawn は project を焼く (作業範囲の監査 / UI 表示用)。
      if (claimed?.project) meta.project = claimed.project;
      if (claimed?.testSurfaceId) meta.test_surface_id = claimed.testSurfaceId;
      // spawn で選ばれた Memoria タスク。 end-session-flow が正常終了時にこれを見て
      // done にするので、 セッション側に id を残すのが唯一の紐付け (spec/feature/teams.md §2)。
      if (claimed?.memoriaTaskId) meta.memoria_task_id = claimed.memoriaTaskId;
      if (claimed?.requesterDiscordUserId) {
        meta.discord_requester_user_id = claimed.requesterDiscordUserId;
      }
      if (claimed?.sourceDiscordGuildId) {
        meta.discord_source_guild_id = claimed.sourceDiscordGuildId;
      }
      if (claimed?.sourceDiscordChannelId) {
        meta.discord_source_channel_id = claimed.sourceDiscordChannelId;
      }
      // タスク本文と作業ポリシーは Discord 上で別 message にする。 混ぜると本文が定型文に
      // 埋もれて「補足」に見え、 タスク未指定の spawn では何も写らなくなる。
      // Cc が spawn したセッション (= claimed あり) はタスク未指定でも空にせず、
      // 「追加指示まで待機」を明示のタスクとして渡す (質問・判断はさせない)。
      if (claimed) {
        meta.discord_startup_task = claimed.startupInjectText?.trim() || BLANK_SESSION_TASK;
      }
      const startupInjectText = [
        sessionWorkPolicyText,
        deps.resolveCcWorkflowEnabled?.()
          ? renderCcWorkflowStartupInject(input.id)
          : null,
      ].filter((text): text is string => Boolean(text?.trim())).join("\n\n");
      if (startupInjectText) meta.discord_startup_inject = startupInjectText;
      if (claimed) {
        meta.goal_and_go = {
          enabled: claimed.goalAndGo,
          continuation_count: 0,
          started_at: null,
          last_continued_at: null,
          stopped_reason: null,
        };
      }
      // /co-relictor・/co-handover の引き継ぎ。handoff 本文は後段で inject する。
      if (successor) {
        relictorHandoff = successor.handoff;
        relictorKind = successor.kind;
        if (successor.goal) meta.goal = successor.goal;
      }
      deps.repo.insertSession({
        id: input.id,
        provider: input.provider as ProviderName,
        repo_path: input.repo_path,
        repo_origin: input.repo_origin ?? null,
        branch: workPolicy.registeredBranch,
        host: input.host,
        started_at: now,
        last_seen_at: now,
        transcript_path: input.transcript_path ?? null,
        metadata: Object.keys(meta).length ? JSON.stringify(meta) : null,
        target_project: input.target_project ?? claimedProjectTarget?.cwd ?? null,
        active_repos: input.active_repos ?? [],
        team_id: claimed?.teamId ?? claimedDelegationRun?.team_id ?? null,
      });
      // タスク名は insertSession の引数に無いので、登録直後に patch で入れる。
      // Discord / WebUI のセッション表示がそのまま「何をしている session か」になる。
      if (claimed?.memoriaTaskTitle) {
        deps.repo.patchSession(input.id, { current_task: claimed.memoriaTaskTitle });
      }
      deps.repo.appendEvent({
        session_id: input.id,
        ts: now,
        kind: "start",
        payload: {
          provider: input.provider,
          host: input.host,
          cwd: input.repo_path,
          branch: workPolicy.registeredBranch,
          requested_branch: claimed?.branch ?? null,
          branch_mismatch: workPolicy.branchMismatch,
        },
      });
      eventBus.emit({
        type: "session.started",
        session_id: input.id,
        provider: input.provider,
        repo_path: input.repo_path,
        branch: workPolicy.registeredBranch,
        ts: now,
      });
      if (claimedDelegationRun?.child_session_id === input.id) {
        projectDelegationSessionLinks(claimedDelegationRun, deps.projectSessionEvent, now);
      }
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
    let processStartup: Awaited<ReturnType<ProcessManager["startFromRepo"]>> | null = null;
    const canStartProcesses =
      !isWorkspaceRootCwd(input.repo_path, workspaceRoots) && existsSync(input.repo_path);
    if (canStartProcesses) {
      try {
        processStartup = await deps.processManager.startFromRepo(input.repo_path, input.repo_origin ?? null);
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
    }

    const freshSession = deps.repo.findSession(input.id)!;
    const contextPacket = await buildCollaborationContextPacket({
      repo: deps.repo,
      session: freshSession,
      workspaceRoots: deps.resolveWorkspaceRoots?.() ?? [],
      resolveProjectNames: () => deps.projectCodes?.list().map((row) => row.project) ?? [],
      ccWorkflowEnabled: deps.resolveCcWorkflowEnabled?.() ?? false,
      escalation: toEscalationDeclaration(deps, input.id),
    });

    if (sessionWorkPolicyText) {
      deps.repo.appendEvent({
        session_id: input.id,
        ts: nowSec(),
        kind: "inject",
        payload: {
          text: sessionWorkPolicyText,
          source: SESSION_WORK_POLICY_SOURCE,
        },
      });
      // Lictor opens its session-scoped WS immediately after register returns.
      // Delay mirrors relictor handoff delivery and avoids racing that attach.
      setTimeout(() => {
        eventBus.emit({
          type: "session.inject",
          target_session_id: input.id,
          text: sessionWorkPolicyText!,
          source: SESSION_WORK_POLICY_SOURCE,
          ts: nowSec(),
        });
      }, 1500).unref?.();
    }

    // /co-relictor 再起動・/co-handover 移行なら、引き継ぎ資料だけを inject して文脈を復元する。
    if (relictorHandoff) {
      const header = relictorKind === "handover" ? HANDOVER_REINJECT_HEADER : RELICTOR_REINJECT_HEADER;
      const source = relictorKind === "handover" ? HANDOVER_INJECT_SOURCE : RELICTOR_INJECT_SOURCE;
      const handoffText = `${header}${relictorHandoff}`;
      deps.repo.appendEvent({
        session_id: input.id,
        ts: nowSec(),
        kind: "inject",
        payload: { text: handoffText, source },
      });
      setTimeout(() => {
        eventBus.emit({
          type: "session.inject",
          target_session_id: input.id,
          text: handoffText,
          source,
          ts: nowSec(),
        });
      }, 1500).unref?.();
    }

    return c.json({
      session: serializeSession(deps.repo.findSession(input.id)!),
      peers: peers.map(serializeSession),
      lost_candidates: lostCandidates.map(serializeSession),
      advisory,
      processes: processStartup,
      process_stream_url: `ws://127.0.0.1:${deps.config.port}/ws`,
      goal: readGoalFromMetadata(freshSession.metadata),
      context_packet: contextPacket,
    });
  });

  // 一覧。 ?limit / ?offset でページングし、 既定では metadata の
  // プロンプト全文級キーを外す (?metadata=full で全文)。
  app.get("/", (c) => {
    const q = c.req.query();
    const subsidiaryId = (q.subsidiary_id ?? "").trim();
    const limit = clampListLimit(q.limit);
    const offset = clampListOffset(q.offset);
    const list = deps.repo.listSessions({
      repo_origin: q.repo_origin || undefined,
      host: q.host || undefined,
      status: (q.status as SessionStatus) || undefined,
      provider: (q.provider as ProviderName) || undefined,
      subsidiary_id: subsidiaryId || undefined,
      team_id: (q.team_id ?? "").trim() || undefined,
      limit,
      offset,
    });
    const full = (q.metadata ?? "").trim() === "full";
    const sessions = full
      ? list.map(serializeSession)
      : list.map((s) => withSlimMetadata(serializeSession(s)));
    return c.json({ sessions, limit, offset });
  });

app.get("/:id/context", async (c) => {
    const id = c.req.param("id");
    const s = deps.repo.findSession(id);
    if (!s) return c.json({ error: "not_found" }, 404);
    return c.json({
      context_packet: await buildCollaborationContextPacket({
        repo: deps.repo,
        session: s,
        workspaceRoots: deps.resolveWorkspaceRoots?.() ?? [],
        resolveProjectNames: () => deps.projectCodes?.list().map((row) => row.project) ?? [],
        ccWorkflowEnabled: deps.resolveCcWorkflowEnabled?.() ?? false,
        escalation: toEscalationDeclaration(deps, id),
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
        return c.json({ session: syntheticPurgedSession(id, span), events: [] });
      }
      return c.json({ error: "not_found" }, 404);
    }
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

app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    // Split off `metadata` — patchSession() only handles the column fields.
    const projectClaimText = [
      parsed.data.current_task,
      parsed.data.branch,
    ].filter((value): value is string => Boolean(value?.trim())).join("\n");
    const inferredTargetProject =
      parsed.data.target_project === undefined && projectClaimText
        ? createProjectResolver(deps.projectCodes?.list() ?? []).targetFromText(projectClaimText)?.cwd
        : undefined;
    const { metadata, ...columnPatch } = {
      ...parsed.data,
      ...(inferredTargetProject ? { target_project: inferredTargetProject } : {}),
    };
    const roots = deps.resolveWorkspaceRoots?.() ?? [];
    const effectiveTargetProject = columnPatch.target_project ?? session.target_project;
    const incomingRootRepo = columnPatch.repo_path && isWorkspaceRootCwd(columnPatch.repo_path, roots);
    const preserveWorkingRepo = Boolean(
      incomingRootRepo
      && !isWorkspaceRootCwd(session.repo_path, roots)
      && isCastraSessionBinding({
        repoPath: session.repo_path,
        targetProject: effectiveTargetProject,
        metadata: session.metadata,
      }, roots),
    );
    if (preserveWorkingRepo) {
      delete columnPatch.repo_path;
      delete columnPatch.repo_origin;
      // A root-derived update reports Castra's branch and may omit the child
      // target. Both would erase the explicit implementation binding.
      delete columnPatch.branch;
      delete columnPatch.target_project;
    }
    const patchTs = nowSec();
    const didChangeBranch = columnPatch.branch !== undefined && columnPatch.branch !== session.branch;
    const didChangeTask = parsed.data.current_task !== undefined && parsed.data.current_task !== session.current_task;
    deps.repo.patchSession(id, columnPatch);
    if (metadata) deps.repo.mergeMetadata(id, metadata);
    deps.repo.updateHeartbeat(id, patchTs);
    reviveIfLost(deps.repo, session, patchTs);
    if (didChangeBranch) {
      eventBus.emit({ type: "session.event", session_id: id, kind: "branch_changed", ts: patchTs });
    }
    if (parsed.data.current_task !== undefined) {
      deps.repo.appendEvent({
        session_id: id,
        ts: patchTs,
        kind: "task_update",
        payload: { current_task: parsed.data.current_task },
      });
    }
    if (didChangeTask) {
      eventBus.emit({
        type: "session.task_changed",
        session_id: id,
        previous_task: session.current_task,
        current_task: parsed.data.current_task ?? null,
        ts: patchTs,
      });
    }
    return c.json({ ok: true });
  });

app.post("/:id/heartbeat", (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    deps.repo.updateHeartbeat(id, nowSec());
    reviveIfLost(deps.repo, session, nowSec());
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
    // 終了の副作用は endSessionNow に集約する (発話由来の終了要求も同じ関数を通る)。
    // report は claude -p を 2 回叩くため非同期生成に回しており、 新規終了では null。
    // (既に ended だった session を再 DELETE した場合のみ、 生成済 report が返る)
    // 生成後の値は GET /v1/reports/:id で読める。
    const { session: ended, report } = await endSessionNow(
      {
        repo: deps.repo,
        chat: deps.chat,
        config: deps.config,
        harnessAudit: deps.harnessAudit,
        transcriptLogs: deps.transcriptLogs,
        questionState: deps.channelDirectory,
        memoria: deps.memoria,
      },
      s,
      "auto on DELETE /v1/sessions/:id",
      nowSec,
    );
    return c.json({ ok: true, session: serializeSession(ended), report });
  });
}
