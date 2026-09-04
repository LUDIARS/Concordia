/**
 * buildApp ベースの API テスト用ファクトリ.
 *
 * これまで各 API テストが ~30 行の repos + buildApp セットアップを逐語コピーし、
 * しかも AppDeps の必須 dep (participants / prs / delegation / modelCatalog 等) を
 * 渡し漏れていた。本 helper は AppDeps を完全に満たした app を 1 行で組み、
 * 副作用 (spawn token / delegation prompt のリポ直下書き込み) を tmpdir に隔離し、
 * 生成リソースを cleanup レジストリ経由で必ず解放する。
 */

import type Database from "better-sqlite3";
import { join } from "node:path";
import { buildApp, type AppDeps } from "../../src/app.js";
import { AdminState } from "../../src/admin/state.js";
import { ChatRepo } from "../../src/db/chat-repo.js";
import { ControlJobsRepo } from "../../src/db/control-jobs-repo.js";
import { CostOneShotCallsRepo } from "../../src/db/cost-one-shot-calls-repo.js";
import { CostLimitSamplesRepo } from "../../src/db/cost-limit-samples-repo.js";
import { CostUsageSamplesRepo } from "../../src/db/cost-usage-samples-repo.js";
import { DayReportsRepo } from "../../src/db/day-reports-repo.js";
import { DelegationRepo } from "../../src/db/delegation-repo.js";
import {
  makeDiscordConfigRepo,
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
} from "../../src/db/discord-repo.js";
import { InjectManualsRepo } from "../../src/db/inject-manuals-repo.js";
import { StaffRepo } from "../../src/db/staff-repo.js";
import { seedInjectManuals } from "../../src/control/inject-manual-seed.js";
import { ModelCatalogRepo } from "../../src/db/model-catalog-repo.js";
import { makeParticipantsRepo } from "../../src/db/participants-repo.js";
import { PrRecordsRepo } from "../../src/db/pr-records-repo.js";
import { ProjectCodesRepo } from "../../src/db/project-codes-repo.js";
import { ProcessesRepo } from "../../src/db/processes-repo.js";
import { RulesRepo } from "../../src/db/rules-repo.js";
import { SessionTaskRecordsRepo } from "../../src/db/session-task-records-repo.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { SkillsRepo } from "../../src/db/skills-repo.js";
import { StatsRepo } from "../../src/db/stats-repo.js";
import { SubsidiaryRepo } from "../../src/db/subsidiary-repo.js";
import { TasksRepo } from "../../src/db/tasks-repo.js";
import { TeamsRepo } from "../../src/db/teams-repo.js";
import { EscalationRepo } from "../../src/db/escalation-repo.js";
import { TranscriptLogsRepo } from "../../src/db/transcript-logs-repo.js";
import { SessionMessagesRepo } from "../../src/db/session-messages-repo.js";
import { SessionMessageReadsRepo } from "../../src/db/session-message-reads-repo.js";
import { SessionMessageService } from "../../src/messages/service.js";
import { WebPushRepo } from "../../src/db/web-push-repo.js";
import { DelegationService } from "../../src/delegation/service.js";
import { seedDelegationTemplates } from "../../src/delegation/seed.js";
import { ProcessManager } from "../../src/processes/manager.js";
import { WebPushService } from "../../src/push/service.js";
import { loadConfig, type ConcordiaConfig } from "../../src/shared/config.js";
import type { SpawnRequest } from "../../src/control/spawner.js";
import type { ConcordiaEvent } from "../../src/events.js";
import { TaskMdStore } from "../../src/taskflow/md-store.js";
import { TaskflowStateStore } from "../../src/taskflow/state-store.js";
import { CcTaskRepository } from "../../src/fallback-tasks/repository.js";
import { inboxItems } from "../../src/inbox/read-model.js";
import { registerCleanup } from "./cleanup.js";
import { makeTestDb, makeTestDir } from "./db.js";

export interface TestAppOptions {
  /** 事前に seed 済みの DB を共有する場合に指定 (省略時は makeTestDb)。 */
  db?: Database.Database;
  /** loadConfig({}) ベースの config への上書き。 */
  config?: Partial<ConcordiaConfig>;
  /** Kept for older tests; dispatcher fanout was removed. */
  rng?: () => number;
  delegationSpawn?: (req: SpawnRequest) => { ok: true; pid: number | null; command: string[] } | { ok: false; error: string };
  sessionSpawn?: (req: SpawnRequest) => { ok: true; pid: number | null; command: string[] } | { ok: false; error: string };
  chatRoutes?: boolean;
  costRoutes?: boolean;
  costOverviewSource?: "live" | "samples";
  /** dist が src より古い状態を再現する (既定 false)。 */
  buildStale?: boolean;
}

export interface TestAppEnv {
  app: ReturnType<typeof buildApp>;
  db: Database.Database;
  repo: SessionsRepo;
  controlJobs: ControlJobsRepo;
  tasks: TasksRepo;
  escalations: EscalationRepo;
  chat: ChatRepo;
  skills: SkillsRepo;
  rules: RulesRepo;
  dayReports: DayReportsRepo;
  processes: ProcessesRepo;
  stats: StatsRepo;
  prs: PrRecordsRepo;
  sessionTaskRecords: SessionTaskRecordsRepo;
  transcriptLogs: TranscriptLogsRepo;
  sessionMessages: SessionMessagesRepo;
  sessionMessageReads: SessionMessageReadsRepo;
  projectSessionEvent: (event: ConcordiaEvent) => void;
  pendingQuestions: ReturnType<typeof makeDiscordPendingQuestionsRepo>;
  discordChannels: ReturnType<typeof makeDiscordSessionChannelsRepo>;
  discordConfig: ReturnType<typeof makeDiscordConfigRepo>;
  participants: ReturnType<typeof makeParticipantsRepo>;
  delegation: DelegationRepo;
  delegationService: DelegationService;
  modelCatalog: ModelCatalogRepo;
  injectManuals: InjectManualsRepo;
  staff: StaffRepo;
  subsidiary: SubsidiaryRepo;
  teams: TeamsRepo;
  adminState: AdminState;
  taskflowState: TaskflowStateStore;
  processManager: ProcessManager;
  config: ConcordiaConfig;
  logsDir: string;
}

export function makeTestApp(opts: TestAppOptions = {}): TestAppEnv {
  const db = opts.db ?? makeTestDb();
  const repo = new SessionsRepo(db);
  const controlJobs = new ControlJobsRepo(db);
  const tasks = new TasksRepo(db);
  const escalations = new EscalationRepo(db);
  const chat = new ChatRepo(db);
  const skills = new SkillsRepo(db);
  const rules = new RulesRepo(db);
  const dayReports = new DayReportsRepo(db);
  const processes = new ProcessesRepo(db);
  const stats = new StatsRepo(db);
  const prs = new PrRecordsRepo(db);
  const projectCodes = new ProjectCodesRepo(db);
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  const transcriptLogs = new TranscriptLogsRepo(db);
  registerCleanup(() => transcriptLogs.close());
  const sessionMessages = new SessionMessagesRepo(db);
  const sessionMessageReads = new SessionMessageReadsRepo(db);
  const adminState = new AdminState(db);
  const sessionMessageService = new SessionMessageService({
    repo: sessionMessages,
    isThinkingEnabled: () => adminState.getThinkingMessagesEnabled(),
  });
  const projectSessionEvent = (event: ConcordiaEvent): void => sessionMessageService.project(event);
  const webPush = new WebPushRepo(db);
  const webPushService = new WebPushService(webPush);
  const pendingQuestions = makeDiscordPendingQuestionsRepo(db);
  const discordChannels = makeDiscordSessionChannelsRepo(db);
  const discordConfig = makeDiscordConfigRepo(db);
  const costSamples = new CostUsageSamplesRepo(db);
  const costLimitSamples = new CostLimitSamplesRepo(db);
  const costOneShots = new CostOneShotCallsRepo(db);
  const participants = makeParticipantsRepo(db);
  const delegation = new DelegationRepo(db);
  seedDelegationTemplates(delegation);
  const modelCatalog = new ModelCatalogRepo(db);
  const injectManuals = new InjectManualsRepo(db);
  seedInjectManuals(injectManuals);
  const staff = new StaffRepo(db);
  const subsidiary = new SubsidiaryRepo(db);
  const teams = new TeamsRepo(db);
  const taskflowState = new TaskflowStateStore(db);
  const fallbackTasks = new CcTaskRepository(db);
  // API テストは実ワークスペースを走査しない。空 root resolver で taskflow I/O を隔離する。
  const taskStore = new TaskMdStore(() => [], undefined, taskflowState);

  // 副作用の隔離: logsDir / spawn token / delegation prompt を全て tmpdir に向ける。
  const logsDir = makeTestDir("concordia-test-logs-");

  const delegationService = new DelegationService({
    repo: delegation,
    promptsDir: join(logsDir, "delegation-prompts"),
    spawn: opts.delegationSpawn ?? (() => ({ ok: true, pid: null, command: [] })),
    teamRules: (value) => {
      const team = teams.findByIdOrSlug(value);
      return team ? {
        id: team.id,
        team: team.name,
        rules: team.rules_text,
        subsidiaryId: team.subsidiary_id,
      } : null;
    },
  });

  const processManager = new ProcessManager({ repo: processes, logsDir });
  const config: ConcordiaConfig = {
    ...loadConfig({}),
    ...opts.config,
  };

  const deps: AppDeps = {
    repo, controlJobs, tasks, escalations, chat, skills, rules, dayReports, processes, stats, prs,
    sessionTaskRecords, transcriptLogs, sessionMessages, sessionMessageReads, webPush, webPushService,
    projectSessionEvent,
    pendingQuestions, discordChannels, discordConfig, costSamples, costLimitSamples, costOneShots,
    participants, delegation, delegationService, modelCatalog, injectManuals, projectCodes, adminState,
    staff, subsidiary, teams,
    taskStore,
    taskflowState,
    fallbackTasks,
    sessionSpawn: opts.sessionSpawn,
    spawnTokenCwd: logsDir,
    onTaskflowCompleted: async () => {},
    costOverviewSource: opts.costOverviewSource,
    processManager,
    dailyScheduler: { stop: () => {}, runOnce: async () => {} },
    config,
    startedAt: new Date().toISOString(),
    buildStale: opts.buildStale ?? false,
    inboxItems: () => inboxItems(db),
    sweeperRunOnce: async () => {},
    toolPath: "/abs/tools/concordia-hook.mjs",
    publicUrl: "http://127.0.0.1:11111",
    chatRoutes: opts.chatRoutes === false ? null : undefined,
    costRoutes: opts.costRoutes === false ? null : undefined,
  };

  const app = buildApp(deps);

  return {
    app,
    db, repo, controlJobs, tasks, escalations, chat, skills, rules, dayReports, processes, stats, prs,
    sessionTaskRecords, transcriptLogs, sessionMessages, sessionMessageReads, projectSessionEvent,
    pendingQuestions, discordChannels, discordConfig,
    participants, delegation, delegationService, modelCatalog, injectManuals, adminState,
    staff, subsidiary, teams,
    taskflowState,
    processManager, config, logsDir,
  };
}
