/**
 * デイリーゴール自走の composition root。 port の実装を組み立て、 scheduler の寿命を所有する。
 *
 * @implements spec/feature/daily-goal-run.md — 状態の所有者 / 予算 / CC-INV-08
 *
 * 他ドメインの状態 (session metadata の goal-and-go・人間待ち・質問・delegation run・Actio) は
 * それぞれの所有者の API を通して読み書きする。 Actio へは読み取りだけ。 投稿の読み取りは
 * 既存の Claude CLI 呼び出し (runClaude、 API キーを使わない)、 日のまとめの記載先は Memoria
 * (接続先はサービス URL `memoria`)。
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
import { DailyGoalDraftRepository } from "../daily-goal-run/draft-repository.js";
import { DailyGoalDayRepository } from "../daily-goal-run/day-repository.js";
import { createLlmGoalExtraction, type GoalExtractionPort } from "../daily-goal-run/goal-extraction.js";
import { createMemoriaJournalHttp, type MemoriaJournalPort } from "../daily-goal-run/memoria-journal.js";
import { runClaude } from "../rules/claude-runner.js";
import { memoriaBaseUrl } from "../config/service-urls.js";
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
  /** 投稿の読み取り。 未指定なら runClaude (Sonnet、 会話のみ) で読む。 */
  extraction?: GoalExtractionPort;
  /** 日のまとめの記載先。 未指定なら Memoria の HTTP API。 */
  journal?: MemoriaJournalPort;
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
    drafts: new DailyGoalDraftRepository(deps.db),
    days: new DailyGoalDayRepository(deps.db),
    extraction: deps.extraction ?? createLlmGoalExtraction((prompt, opts) => runClaude(prompt, opts), { model: "sonnet" }),
    journal: deps.journal ?? createMemoriaJournalHttp({ baseUrl: memoriaBaseUrl() }),
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
      // コードは完全一致、 名前は大文字小文字を無視。 複数のプロジェクトに当たれば一意でないので採用しない。
      resolve: (value) => {
        const exact = deps.projectCodes.findByCode(value.trim());
        if (exact) return { project: exact.project, repoPath: exact.repo_path };
        const wanted = value.trim().toLowerCase();
        const hits = deps.projectCodes.list().filter((item) => item.project.toLowerCase() === wanted || item.code.toLowerCase() === wanted);
        const projects = new Set(hits.map((item) => item.project));
        return projects.size === 1 ? { project: hits[0]!.project, repoPath: hits[0]!.repo_path } : null;
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
