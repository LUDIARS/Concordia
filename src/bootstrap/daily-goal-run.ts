/**
 * デイリーゴールの composition root。 port の実装を組み立て、 scheduler の寿命を所有する。
 *
 * @implements spec/feature/daily-goal-run.md — 状態の所有者 / 4. ワンショット確認 / 予算
 *
 * 他ドメインの状態 (session・pr_records・Revisor・Actio) は読み取りだけ。 セッションは起動しない。
 * 投稿の読み取りと進み具合の判定は既存の Claude CLI 呼び出し (runClaude、 会話のみ、 API キーを
 * 使わない) で 1 回ずつ行い、 日のまとめの記載先は Memoria (接続先はサービス URL `memoria`)。
 */

import type { Database } from "better-sqlite3";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { StaffRepo } from "../db/staff-repo.js";
import type { TaskStore } from "../taskflow/store.js";
import type { SettingsStore } from "../admin/settings-store.js";
import { DailyGoalRepository } from "../daily-goal-run/repository.js";
import { DailyGoalDraftRepository } from "../daily-goal-run/draft-repository.js";
import { DailyGoalDayRepository } from "../daily-goal-run/day-repository.js";
import { DailyGoalAlertRepository } from "../daily-goal-run/alert-repository.js";
import { createLlmGoalExtraction, type GoalExtractionPort } from "../daily-goal-run/goal-extraction.js";
import { createLlmProgressJudge, type ProgressJudgePort } from "../daily-goal-run/progress-judge.js";
import { createMemoriaJournalHttp, type MemoriaJournalPort } from "../daily-goal-run/memoria-journal.js";
import { runClaude } from "../rules/claude-runner.js";
import { memoriaBaseUrl } from "../config/service-urls.js";
import { DailyGoalRunService } from "../daily-goal-run/service.js";
import { createEvidenceAdapter } from "../daily-goal-run/evidence.js";
import { resolveDailyGoalConfig } from "../daily-goal-run/config.js";
import { startDailyGoalScheduler, type DailyGoalSchedulerHandle } from "../daily-goal-run/scheduler.js";
import { createDailyGoalSurface } from "../daily-goal-run/surface.js";
import type { DailyGoalSurfacePort } from "../daily-goal-run/surface-port.js";
import type { RevisorLocalPr } from "../pr/revisor-client.js";

export interface DailyGoalRuntimeDeps {
  db: Database;
  sessions: Pick<SessionsRepo, "findSession">;
  prs: Pick<PrRecordsRepo, "list">;
  projectCodes: Pick<ProjectCodesRepo, "findByCode" | "list">;
  staff: Pick<StaffRepo, "roleOf">;
  taskStore: () => TaskStore | null;
  revisor?: {
    findLocalPrByBranch?(repository: string, branch: string): Promise<RevisorLocalPr | null>;
    listLocalPrs?(): Promise<RevisorLocalPr[]>;
  } | null;
  settings: Pick<SettingsStore, "get">;
  isEnabled: () => boolean;
  /** 投稿の読み取り。 未指定なら runClaude (Sonnet、 会話のみ) で読む。 */
  extraction?: GoalExtractionPort;
  /** 進み具合の判定。 未指定なら runClaude (Sonnet、 会話のみ) で 1 回だけ呼ぶ。 */
  judge?: ProgressJudgePort;
  /** 日のまとめの記載先。 未指定なら Memoria の HTTP API。 */
  journal?: MemoriaJournalPort;
  log: { info(message: string): void; warn(message: string): void };
}

export interface DailyGoalRuntime {
  service: DailyGoalRunService;
  surface: DailyGoalSurfacePort;
  startScheduler(): DailyGoalSchedulerHandle;
}

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function createDailyGoalRuntime(deps: DailyGoalRuntimeDeps): DailyGoalRuntime {
  const { sessions } = deps;
  const revisor = deps.revisor;
  const service = new DailyGoalRunService({
    repo: new DailyGoalRepository(deps.db),
    drafts: new DailyGoalDraftRepository(deps.db),
    days: new DailyGoalDayRepository(deps.db),
    alerts: new DailyGoalAlertRepository(deps.db),
    extraction: deps.extraction ?? createLlmGoalExtraction((prompt, opts) => runClaude(prompt, opts), { model: "sonnet" }),
    judge: deps.judge ?? createLlmProgressJudge((prompt, opts) => runClaude(prompt, opts), { model: "sonnet" }),
    journal: deps.journal ?? createMemoriaJournalHttp({ baseUrl: memoriaBaseUrl() }),
    evidence: createEvidenceAdapter({
      session: (id) => {
        const row = sessions.findSession(id);
        return row ? { repo_path: row.repo_path, repo_origin: row.repo_origin, branch: row.branch } : null;
      },
      prsBySession: (id) => deps.prs.list({ author_session_id: id, limit: 100 }),
      ...(revisor?.findLocalPrByBranch
        ? { revisorByBranch: (repository: string, branch: string) => revisor.findLocalPrByBranch!(repository, branch) }
        : {}),
      repoOrigin: (repoPath) => {
        const wanted = normalizePath(repoPath);
        return deps.projectCodes.list().find((row) => normalizePath(row.repo_path) === wanted && row.repo_origin)?.repo_origin ?? null;
      },
      prsByRepo: (origin) => deps.prs.list({ repo_origin: origin, limit: 100 }),
      ...(revisor?.listLocalPrs
        ? {
            revisorByRepository: async (repository: string) => {
              const wanted = repository.toLowerCase();
              return (await revisor.listLocalPrs!()).filter((pr) => pr.repository.toLowerCase() === wanted);
            },
          }
        : {}),
      taskStatus: async (repoPath, reference) => {
        const store = deps.taskStore();
        if (!store) throw new Error("task store unavailable");
        return store.findByRelativePath(repoPath, reference);
      },
    }),
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
    log: deps.log,
  });
  return {
    service,
    surface: createDailyGoalSurface(service, {
      roleOf: (userId) => deps.staff.roleOf("discord", userId),
      isEnabled: deps.isEnabled,
    }),
    startScheduler: () => startDailyGoalScheduler({ service, log: deps.log }),
  };
}
