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
import { ModelCatalogRepo } from "../../src/db/model-catalog-repo.js";
import { makeParticipantsRepo } from "../../src/db/participants-repo.js";
import { PersonasRepo } from "../../src/db/personas-repo.js";
import { PrRecordsRepo } from "../../src/db/pr-records-repo.js";
import { ProcessesRepo } from "../../src/db/processes-repo.js";
import { RulesRepo } from "../../src/db/rules-repo.js";
import { SessionTaskRecordsRepo } from "../../src/db/session-task-records-repo.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { SkillsRepo } from "../../src/db/skills-repo.js";
import { StatsRepo } from "../../src/db/stats-repo.js";
import { TasksRepo } from "../../src/db/tasks-repo.js";
import { TranscriptLogsRepo } from "../../src/db/transcript-logs-repo.js";
import { DelegationService } from "../../src/delegation/service.js";
import { seedDelegationTemplates } from "../../src/delegation/seed.js";
import { Dispatcher } from "../../src/dispatcher.js";
import { ChatResponder } from "../../src/chat/responder.js";
import { seedPersonas } from "../../src/personas/seeds.js";
import { ProcessManager } from "../../src/processes/manager.js";
import { loadConfig, type ConcordiaConfig } from "../../src/shared/config.js";
import type { SpawnRequest } from "../../src/control/spawner.js";
import { registerCleanup } from "./cleanup.js";
import { makeTestDb, makeTestDir } from "./db.js";

export interface TestAppOptions {
  /** 事前に seed 済みの DB を共有する場合に指定 (省略時は makeTestDb)。 */
  db?: Database.Database;
  /** loadConfig({}) ベースの config への上書き (adminToken 等)。 */
  config?: Partial<ConcordiaConfig>;
  /** Dispatcher の rng (default: () => 1)。 */
  rng?: () => number;
  delegationSpawn?: (req: SpawnRequest) => { ok: true; pid: number | null; command: string[] } | { ok: false; error: string };
  chatRoutes?: boolean;
  costRoutes?: boolean;
}

export interface TestAppEnv {
  app: ReturnType<typeof buildApp>;
  db: Database.Database;
  repo: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  skills: SkillsRepo;
  rules: RulesRepo;
  dayReports: DayReportsRepo;
  personas: PersonasRepo;
  processes: ProcessesRepo;
  stats: StatsRepo;
  prs: PrRecordsRepo;
  sessionTaskRecords: SessionTaskRecordsRepo;
  transcriptLogs: TranscriptLogsRepo;
  pendingQuestions: ReturnType<typeof makeDiscordPendingQuestionsRepo>;
  discordChannels: ReturnType<typeof makeDiscordSessionChannelsRepo>;
  discordConfig: ReturnType<typeof makeDiscordConfigRepo>;
  participants: ReturnType<typeof makeParticipantsRepo>;
  delegation: DelegationRepo;
  delegationService: DelegationService;
  modelCatalog: ModelCatalogRepo;
  adminState: AdminState;
  processManager: ProcessManager;
  dispatcher: Dispatcher;
  config: ConcordiaConfig;
  logsDir: string;
}

export function makeTestApp(opts: TestAppOptions = {}): TestAppEnv {
  const db = opts.db ?? makeTestDb();
  const repo = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const skills = new SkillsRepo(db);
  const rules = new RulesRepo(db);
  const dayReports = new DayReportsRepo(db);
  const personas = new PersonasRepo(db);
  seedPersonas(personas);
  const processes = new ProcessesRepo(db);
  const stats = new StatsRepo(db);
  const prs = new PrRecordsRepo(db);
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  const transcriptLogs = new TranscriptLogsRepo(db);
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
  const adminState = new AdminState(db);

  // 副作用の隔離: logsDir / spawn token / delegation prompt を全て tmpdir に向ける。
  // CONCORDIA_SPAWN_TOKEN_PATH を設定しないと buildApp (spawnRouter) が
  // process.cwd() = リポ直下に .spawn.token を書いてしまう。
  const logsDir = makeTestDir("concordia-test-logs-");
  const prevTokenPath = process.env.CONCORDIA_SPAWN_TOKEN_PATH;
  process.env.CONCORDIA_SPAWN_TOKEN_PATH = join(logsDir, ".spawn.token");
  registerCleanup(() => {
    if (prevTokenPath === undefined) delete process.env.CONCORDIA_SPAWN_TOKEN_PATH;
    else process.env.CONCORDIA_SPAWN_TOKEN_PATH = prevTokenPath;
  });

  const delegationService = new DelegationService({
    repo: delegation,
    personas,
    promptsDir: join(logsDir, "delegation-prompts"),
    spawn: opts.delegationSpawn ?? (() => ({ ok: true, pid: null, command: [] })),
  });

  const processManager = new ProcessManager({ repo: processes, logsDir });
  // template renderer = LLM 非使用 (テストで実 API/CLI を叩かない).
  const responder = new ChatResponder({
    chat, personas, sessions: repo,
    renderConfig: () => ({ renderer: "template", model: "" }),
  });
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, responder, rng: opts.rng ?? (() => 1) });
  responder.attachFanout(dispatcher);
  const config: ConcordiaConfig = {
    ...loadConfig({}),
    ...opts.config,
  };

  const deps: AppDeps = {
    repo, tasks, chat, skills, rules, dayReports, personas, processes, stats, prs,
    sessionTaskRecords, transcriptLogs, pendingQuestions, discordChannels, discordConfig, costSamples, costLimitSamples, costOneShots,
    participants, delegation, delegationService, modelCatalog, adminState,
    processManager, dispatcher,
    dailyScheduler: { stop: () => {}, runOnce: async () => {} },
    config,
    startedAt: new Date().toISOString(),
    sweeperRunOnce: () => {},
    toolPath: "/abs/tools/concordia-hook.mjs",
    publicUrl: "http://127.0.0.1:11111",
    chatRoutes: opts.chatRoutes === false ? null : undefined,
    costRoutes: opts.costRoutes === false ? null : undefined,
  };

  return {
    app: buildApp(deps),
    db, repo, tasks, chat, skills, rules, dayReports, personas, processes, stats, prs,
    sessionTaskRecords, transcriptLogs, pendingQuestions, discordChannels, discordConfig,
    participants, delegation, delegationService, modelCatalog, adminState,
    processManager, dispatcher, config, logsDir,
  };
}
