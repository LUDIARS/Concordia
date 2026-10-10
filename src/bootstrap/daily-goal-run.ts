/**
 * デイリーゴール自走の composition root。 port の実装を組み立て、 scheduler の寿命を所有する。
 *
 * @implements spec/feature/daily-goal-run.md — 状態の所有者 / 予算 / CC-INV-08
 *
 * 他ドメインの状態 (session metadata の goal-and-go・人間待ち・質問・delegation run・Actio) は
 * それぞれの所有者の API を通して読み書きする。 Actio へは読み取りだけ。
 */

import type { Database } from "better-sqlite3";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationRepo } from "../db/delegation-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { StaffRepo } from "../db/staff-repo.js";
import type { DelegationService } from "../delegation/service.js";
import type { TaskStore } from "../taskflow/store.js";
import type { SettingsStore } from "../admin/settings-store.js";
import { eventBus } from "../events.js";
import { resetGoalAndGoBudget, setGoalAndGoEnabled } from "../control/goal-and-go.js";
import { isHumanWaitActive } from "../control/human-wait.js";
import { allowAutoInject, isBlockedByPendingQuestion, pendingQuestionProbe } from "../control/pending-question-blocker.js";
import { DailyGoalRepository } from "../daily-goal-run/repository.js";
import { DailyGoalRunService } from "../daily-goal-run/service.js";
import { createEvidenceAdapter } from "../daily-goal-run/evidence.js";
import { resolveDailyGoalConfig } from "../daily-goal-run/config.js";
import { DAILY_GOAL_INJECT_SOURCE } from "../daily-goal-run/prompts.js";
import { DAILY_GOAL_RUNNER_CALL_NAME } from "../daily-goal-run/launch.js";
import { startDailyGoalScheduler, type DailyGoalSchedulerHandle } from "../daily-goal-run/scheduler.js";
import { createDailyGoalSurface } from "../daily-goal-run/surface.js";
import type { DailyGoalSurfacePort } from "../daily-goal-run/surface-port.js";
import type { RevisorLocalPr } from "../pr/revisor-client.js";

export interface DailyGoalRuntimeDeps {
  db: Database;
  sessions: SessionsRepo;
  delegationRepo: Pick<DelegationRepo, "findRun">;
  delegationService: Pick<DelegationService, "invoke">;
  prs: Pick<PrRecordsRepo, "list">;
  projectCodes: Pick<ProjectCodesRepo, "findByCode" | "list">;
  pendingQuestions: Pick<DiscordPendingQuestionsRepo, "findLatestUnanswered" | "findById">;
  staff: Pick<StaffRepo, "roleOf">;
  taskStore: () => TaskStore | null;
  revisor?: { findLocalPrByBranch?(repository: string, branch: string): Promise<RevisorLocalPr | null> } | null;
  settings: Pick<SettingsStore, "get">;
  isEnabled: () => boolean;
  baseUrl: string;
  log: { info(message: string): void; warn(message: string): void };
}

export interface DailyGoalRuntime {
  service: DailyGoalRunService;
  surface: DailyGoalSurfacePort;
  startScheduler(): DailyGoalSchedulerHandle;
}

export function createDailyGoalRuntime(deps: DailyGoalRuntimeDeps): DailyGoalRuntime {
  const { sessions } = deps;
  const probe = pendingQuestionProbe(deps.pendingQuestions);
  const isWaiting = (sessionId: string): boolean => {
    try { return isBlockedByPendingQuestion(probe, sessionId) || isHumanWaitActive(sessions, sessionId); }
    catch { return true; }
  };
  const service = new DailyGoalRunService({
    repo: new DailyGoalRepository(deps.db),
    evidence: createEvidenceAdapter({
      session: (id) => {
        const row = sessions.findSession(id);
        return row ? { repo_path: row.repo_path, repo_origin: row.repo_origin, branch: row.branch } : null;
      },
      prsBySession: (id) => deps.prs.list({ author_session_id: id, limit: 100 }),
      ...(deps.revisor?.findLocalPrByBranch
        ? { revisorByBranch: (repository: string, branch: string) => deps.revisor!.findLocalPrByBranch!(repository, branch) }
        : {}),
      taskStatus: async (repoPath, reference) => {
        const store = deps.taskStore();
        if (!store) throw new Error("task store unavailable");
        return store.findByRelativePath(repoPath, reference);
      },
    }),
    delegation: {
      launch: async (input) => {
        const result = await deps.delegationService.invoke({
          reserved_run_id: input.runId,
          call_name: DAILY_GOAL_RUNNER_CALL_NAME,
          args: input.args,
          cwd: input.cwd,
          project: input.project,
          triggered_by: "daily-goal-run",
          spawn: true,
          options: { goal_and_go: true },
          // 既存の Actio task を参照するだけで、新しい task を封印しない (CC-DG-INV-08)。
          task_binding: "caller",
          requester_discord_user_id: input.requesterDiscordUserId,
          source_discord_guild_id: input.sourceGuildId,
          source_discord_channel_id: input.sourceChannelId,
        });
        return result.ok ? { ok: true, runId: result.run.id } : { ok: false, error: result.error };
      },
      findRun: (runId) => {
        const run = deps.delegationRepo.findRun(runId);
        return run ? { id: run.id, status: run.status, childSessionId: run.child_session_id } : null;
      },
    },
    sessions: {
      find: (id) => {
        const row = sessions.findSession(id);
        return row ? { id: row.id, status: row.status, metadata: row.metadata } : null;
      },
      updateMetadata: (id, update) => {
        const row = sessions.findSession(id);
        if (row) sessions.setMetadata(id, update(row.metadata));
      },
    },
    waiting: {
      isWaiting,
      isUnansweredQuestion: (sessionId, questionId) => {
        const row = deps.pendingQuestions.findById(questionId);
        return !!row && row.session_id === sessionId && row.answered_at === null;
      },
      isHumanWaitActive: (sessionId) => isHumanWaitActive(sessions, sessionId),
    },
    autonomy: {
      resetBudget: (sessionId) => { resetGoalAndGoBudget(sessions, sessionId); },
      disable: (sessionId) => {
        const row = sessions.findSession(sessionId);
        if (row) sessions.setMetadata(sessionId, setGoalAndGoEnabled(row.metadata, false));
      },
    },
    inject: {
      inject: (sessionId, text) => {
        // 送る直前にもう一度、未回答の質問と人間待ちを確かめる (CC-INV-08)。
        if (isHumanWaitActive(sessions, sessionId)
          || !allowAutoInject({ probe, sessionId, source: DAILY_GOAL_INJECT_SOURCE, log: deps.log })) return;
        const ts = Math.floor(Date.now() / 1000);
        sessions.appendEvent({ session_id: sessionId, ts, kind: "inject", payload: { text, source: DAILY_GOAL_INJECT_SOURCE } });
        eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source: DAILY_GOAL_INJECT_SOURCE, ts });
      },
    },
    projects: {
      resolve: (value) => {
        const row = deps.projectCodes.findByCode(value)
          ?? deps.projectCodes.list().find((item) => item.project.toLowerCase() === value.toLowerCase());
        return row ? { project: row.project, repoPath: row.repo_path } : null;
      },
    },
    tasks: {
      activeTasks: async (project) => {
        const store = deps.taskStore();
        if (!store) return [];
        const documents = await store.findForProject(project, ["pending", "delegated"]);
        return documents.map((doc) => ({
          id: doc.path.replace(/^actio:/, ""),
          title: doc.title,
          status: doc.runtime?.status ?? "pending",
          dueAt: typeof doc.frontmatter.due_at === "string" ? doc.frontmatter.due_at : null,
        }));
      },
    },
    config: () => resolveDailyGoalConfig((key) => deps.settings.get(key)),
    baseUrl: deps.baseUrl,
    log: deps.log,
  });
  return {
    service,
    surface: createDailyGoalSurface(service, {
      roleOf: (userId) => deps.staff.roleOf("discord", userId),
      isEnabled: deps.isEnabled,
    }),
    startScheduler: () => startDailyGoalScheduler({
      service,
      subscribeSessionGone: (handler) => eventBus.subscribe((event) => {
        if (event.type === "session.lost" || event.type === "session.ended") handler(event.session_id);
      }),
      log: deps.log,
    }),
  };
}
