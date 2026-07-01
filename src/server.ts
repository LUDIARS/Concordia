/**
 * Concordia backend エントリポイント.
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, isLoopbackHost } from "./shared/config.js";
import { createChildLogger } from "./shared/logger.js";
import { openDb, closeDb } from "./db/index.js";
import { SessionsRepo } from "./db/sessions-repo.js";
import { makeParticipantsRepo } from "./db/participants-repo.js";
import { TasksRepo } from "./db/tasks-repo.js";
import { ChatRepo } from "./db/chat-repo.js";
import { SkillsRepo } from "./db/skills-repo.js";
import { RulesRepo, seedDefaultRules } from "./db/rules-repo.js";
import { DayReportsRepo } from "./db/day-reports-repo.js";
import { PersonasRepo } from "./db/personas-repo.js";
import { ProcessesRepo } from "./db/processes-repo.js";
import { StatsRepo } from "./db/stats-repo.js";
import { PrRecordsRepo } from "./db/pr-records-repo.js";
import { SessionTaskRecordsRepo } from "./db/session-task-records-repo.js";
import { TranscriptLogsRepo } from "./db/transcript-logs-repo.js";
import {
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
  makeDiscordConfigRepo,
} from "./db/discord-repo.js";
import { DelegationRepo } from "./db/delegation-repo.js";
import { DelegationService } from "./delegation/service.js";
import { seedDelegationTemplates } from "./delegation/seed.js";
import { ModelCatalogRepo } from "./db/model-catalog-repo.js";
import { seedModelCatalog } from "./model-catalog/seed.js";
import { SubsidiaryRepo } from "./db/subsidiary-repo.js";
import { HarnessRulesRepo } from "./db/harness-rules-repo.js";
import { HarnessAuditRepo } from "./db/harness-audit-repo.js";
import { seedHarnessRules } from "./subsidiary/harness-seed.js";
import { SubsidiaryBotManager } from "./subsidiary/manager.js";
import { SubsidiaryBudgetTracker } from "./subsidiary/budget.js";
import { runClaude } from "./rules/claude-runner.js";
import { AdminState } from "./admin/state.js";
import { setLictorLauncherResolver, setConcordiaAddress } from "./control/spawner.js";
import { resolveLictorLauncher } from "./control/lictor-launcher.js";
import type { WorkflowAction } from "./platform/reaction-workflow.js";
import { ProcessManager } from "./processes/manager.js";
import { seedPersonas } from "./personas/seeds.js";
import { collectBoyakiToPersona } from "./personas/boyaki.js";
import { Dispatcher } from "./dispatcher.js";
import { ChatResponder } from "./chat/responder.js";
import { resolveRenderConfig } from "./chat/render-config.js";
import { CostBudgetRepo } from "./cost/cost-budget-repo.js";
import { CostUsageTracker } from "./cost/usage-tracker.js";
import { CostUsageSamplesRepo } from "./db/cost-usage-samples-repo.js";
import { CostOneShotCallsRepo } from "./db/cost-one-shot-calls-repo.js";
import { collectUsageSamples } from "./cost/usage-sampler.js";
import { startSweeper } from "./sweeper.js";
import { startReaper } from "./control/reaper.js";
import { startStalledSessionNudge } from "./control/stalled-session-nudge.js";
import { startAutoCompaction } from "./control/auto-compaction.js";
import { runCompaction, makeCompactionIO } from "./control/compaction.js";
import { MetricsStore } from "./metrics/store.js";
import { startMetricsLoop } from "./metrics/loop.js";
import { startRuleEngine } from "./rules/engine.js";
import { startDailyScheduler } from "./daily/scheduler.js";
import { startMorningScheduler } from "./morning/scheduler.js";
import { startStatScheduler } from "./stat/scheduler.js";
import { startRepoChangeWatcher } from "./stat/repo-change-watcher.js";
import { startPrIngestWatcher } from "./pr/ingest.js";
import { startPrReconciler } from "./pr/reconcile.js";
import { startPrFullSync } from "./pr/full-sync.js";
import { startErrorFixDispatcher } from "./control/error-fix.js";
import { buildApp } from "./app.js";
import { attachWsServer } from "./api/ws.js";
import { eventBus } from "./events.js";
import type { DiscordBotDeps, DiscordBotHandle } from "./discord/bot.js";
import { startDiscordBot } from "./discord/bot.js";
import { initReactionWorkflow } from "./platform/reaction-workflow-loader.js";
import type { SlackBotDeps } from "./slack/bot.js";
import { startSlackBot } from "./slack/bot.js";
import { makeSlackConfigRepo } from "./db/slack-config-repo.js";
import { resolveSlackConfig } from "./slack/config.js";
import { resolveDiscordConfig } from "./discord/conn-config.js";
import { loadSecretBox } from "./shared/secret-box.js";
import type { ChatPlatform } from "./platform/chat-platform.js";

const log = createChildLogger("server");

/** コストトラッカーのサンプリング間隔 (ms)。 2 分毎にログ走査して当日消費を更新。 */
const COST_SAMPLE_INTERVAL_MS = 2 * 60 * 1000;
/** 使用量時系列サンプルの記録間隔 (ms)。 10 分毎 (WebUI /cost グラフ用)。 */
const USAGE_SAMPLE_INTERVAL_MS = 10 * 60 * 1000;
/** 使用量サンプルの保持期間 (秒)。 これより古い行は掃除する (60 日)。 */
const USAGE_SAMPLE_RETENTION_SEC = 60 * 24 * 60 * 60;
let discordBotHandle: DiscordBotHandle | null = null;
let discordBotDeps: DiscordBotDeps | null = null;
let slackBotHandle: ChatPlatform | null = null;
let slackBotDeps: SlackBotDeps | null = null;

async function startSlackBotManaged(): Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }> {
  if (slackBotHandle) return { ok: true, status: "already_running" };
  if (!slackBotDeps) return { ok: false, status: "error", error: "slack deps not initialized" };
  try {
    const h = await startSlackBot(slackBotDeps);
    if (!h) return { ok: true, status: "disabled" };
    slackBotHandle = h;
    return { ok: true, status: "started" };
  } catch (e) {
    return { ok: false, status: "error", error: (e as Error).message };
  }
}

async function stopSlackBotManaged(): Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }> {
  if (!slackBotHandle) return { ok: true, status: "already_stopped" };
  try {
    await slackBotHandle.stop();
    slackBotHandle = null;
    return { ok: true, status: "stopped" };
  } catch (e) {
    return { ok: false, status: "error", error: (e as Error).message };
  }
}

async function restartSlackBotManaged(): Promise<{ ok: boolean; status: "restarted" | "started" | "disabled" | "error"; error?: string }> {
  const stop = await stopSlackBotManaged();
  if (!stop.ok) return { ok: false, status: "error", error: stop.error };
  const start = await startSlackBotManaged();
  if (!start.ok) return { ok: false, status: "error", error: start.error };
  if (start.status === "disabled") return { ok: true, status: "disabled" };
  return { ok: true, status: stop.status === "already_stopped" ? "started" : "restarted" };
}

async function startDiscordBotManaged(): Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }> {
  if (discordBotHandle) return { ok: true, status: "already_running" };
  if (!discordBotDeps) return { ok: false, status: "error", error: "discord deps not initialized" };
  try {
    const h = await startDiscordBot(discordBotDeps);
    if (!h) return { ok: true, status: "disabled" };
    discordBotHandle = h;
    return { ok: true, status: "started" };
  } catch (e) {
    return { ok: false, status: "error", error: (e as Error).message };
  }
}

async function stopDiscordBotManaged(): Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }> {
  if (!discordBotHandle) return { ok: true, status: "already_stopped" };
  try {
    await discordBotHandle.stop();
    discordBotHandle = null;
    return { ok: true, status: "stopped" };
  } catch (e) {
    return { ok: false, status: "error", error: (e as Error).message };
  }
}

async function restartDiscordBotManaged(): Promise<{ ok: boolean; status: "restarted" | "started" | "disabled" | "error"; error?: string }> {
  const stop = await stopDiscordBotManaged();
  if (!stop.ok) return { ok: false, status: "error", error: stop.error };
  const start = await startDiscordBotManaged();
  if (!start.ok) return { ok: false, status: "error", error: start.error };
  if (start.status === "disabled") return { ok: true, status: "disabled" };
  return { ok: true, status: stop.status === "already_stopped" ? "started" : "restarted" };
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export interface BackendHandle {
  port: number;
  shutdown: () => Promise<void>;
}

export async function startBackend(): Promise<BackendHandle> {
  loadDotEnv(join(process.cwd(), ".env"));
  const cfg = loadConfig();

  // 信頼境界の強制: 非 loopback bind (0.0.0.0 / LAN IP 等) は admin API を localhost の
  // 外へ晒す。 warn を出し、 admin token 未設定なら起動拒否する (CWE-306 / CWE-1188)。
  if (!isLoopbackHost(cfg.host)) {
    log.warn(
      { host: cfg.host },
      "Concordia is binding to a non-loopback host — admin API (/v1/admin/*, /v1/sweeper/run) would be reachable beyond localhost",
    );
    if (!cfg.adminToken) {
      throw new Error(
        `CONCORDIA_HOST=${cfg.host} is non-loopback but CONCORDIA_ADMIN_TOKEN is unset. ` +
          `Refusing to start: set CONCORDIA_ADMIN_TOKEN to require auth on admin endpoints, or bind to 127.0.0.1.`,
      );
    }
  }

  const dbPath = cfg.dbPath;

  const db = openDb(dbPath);
  const repo = new SessionsRepo(db);
  // プロセス再起動時は in-memory の WS 接続が全部消えているので、
  // sessions.ws_clients を 0 にリセットして整合性を保つ.
  const resetCount = repo.resetAllWsClients();
  if (resetCount > 0) {
    log.info({ count: resetCount }, "ws_clients reset on boot");
  }
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const skills = new SkillsRepo(db);
  const rules = new RulesRepo(db);
  const dayReports = new DayReportsRepo(db);
  const personas = new PersonasRepo(db);
  const processes = new ProcessesRepo(db);
  const stats = new StatsRepo(db);
  const prs = new PrRecordsRepo(db);
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  const transcriptLogs = new TranscriptLogsRepo(db);
  const pendingQuestions = makeDiscordPendingQuestionsRepo(db);
  // Discord channel/config repos は bot 起動とは独立に (bot OFF でも) Lictor の
  // discord-channels lookup / egress 明示 routing で使うので app 層にも渡す.
  const discordChannels = makeDiscordSessionChannelsRepo(db);
  const discordConfig = makeDiscordConfigRepo(db);
  // Slack 連携をサービス内 (DB) で設定するための repo + token 暗号化用 secret-box。
  // 鍵は DB の外 (env CONCORDIA_SECRET_KEY、 無ければ cwd の concordia.secret.key) に置く。
  const slackConfig = makeSlackConfigRepo(db);
  const secretBox = loadSecretBox({
    envValue: process.env.CONCORDIA_SECRET_KEY,
    keyFile: join(process.cwd(), "concordia.secret.key"),
  });
  const participants = makeParticipantsRepo(db);
  const delegationRepo = new DelegationRepo(db);
  const modelCatalog = new ModelCatalogRepo(db);
  const subsidiaryRepo = new SubsidiaryRepo(db);
  const harnessRepo = new HarnessRulesRepo(db);
  const harnessAuditRepo = new HarnessAuditRepo(db);
  // 子会社の日次トークン予算トラッカー。 subsidiary_id タグ付きセッションの当日消費を
  // ログから直接合算する (グローバル予算と違い delta 累積は不要 = 冪等)。
  const subsidiaryBudget = new SubsidiaryBudgetTracker({ sessionsRepo: repo });
  const publicUrlForDelegation = `http://${cfg.host}:${cfg.port}`;
  const delegationService = new DelegationService({
    repo: delegationRepo,
    personas,
    concordiaUrl: publicUrlForDelegation,
  });
  const workspaceRootDefault = cfg.workspaceRoot || cfg.spawnDefaultCwd;
  const adminState = new AdminState(db, {
    workspaceRoot: workspaceRootDefault,
    workspaceRoots: cfg.workspaceRoots.length ? cfg.workspaceRoots : (workspaceRootDefault ? [workspaceRootDefault] : []),
    githubOrg: cfg.githubOrg,
    reactionWorkflowEnabled: process.env.CONCORDIA_REACTION_WORKFLOW === "1",
    // dev モードの Lictor リポ既定 (= <workspaceRoot>/Lictor)。 空でも GUI で設定可。
    lictorDevPath: workspaceRootDefault ? join(workspaceRootDefault, "Lictor") : "",
  });
  // spawn の Lictor launcher を AdminState 設定から live 解決する (dev/prod/auto)。
  setLictorLauncherResolver(() => resolveLictorLauncher(adminState));
  // spawn する Lictor が必ず spawning Concordia を指すよう、 自分の listen アドレスを
  // env 継承ではなく CONCORDIA_HOST / CONCORDIA_PORT として明示注入する。
  setConcordiaAddress(() => ({ host: cfg.host, port: cfg.port }));

  // コスト予算 (日次トークン上限) — 全ログ走査でトークン消費を蓄積し、 超過で
  // Concordia 発の命令 (spawn / dispatcher / rule engine / proposer) を止める。
  const costBudgetRepo = new CostBudgetRepo(db);
  const costTracker = new CostUsageTracker({
    repo: costBudgetRepo,
    getBudget: () => adminState.getDailyTokenBudget(),
  });
  const isCostBlocked = () => costTracker.isBlocked();
  // 起動直後に baseline を作る (既存ログの累積を当日へ誤計上しないため即サンプル)。
  try {
    costTracker.sample();
  } catch (e) {
    log.warn(`cost tracker initial sample failed: ${(e as Error).message}`);
  }
  const costSampleTimer = setInterval(() => {
    try {
      costTracker.sample();
    } catch (e) {
      log.warn(`cost tracker sample failed: ${(e as Error).message}`);
    }
  }, COST_SAMPLE_INTERVAL_MS);
  costSampleTimer.unref?.();

  // 10 分毎に全 active セッションの「現在のコンテキスト占有」+「累積消費トークン」を
  // subsidiary/provider タグ付きで時系列テーブルへ記録する。 WebUI /cost が折れ線グラフに繋ぐ。
  // (予算トラッカーの 2 分サンプルとは別系統 — あちらは合計の日次バケットのみ。)
  const usageSamplesRepo = new CostUsageSamplesRepo(db);
  const costOneShotsRepo = new CostOneShotCallsRepo(db);
  const sampleUsage = (): void => {
    try {
      const active = repo.listSessions({ status: "active" });
      const nowSec = Math.floor(Date.now() / 1000);
      usageSamplesRepo.insertMany(collectUsageSamples(active, nowSec));
      usageSamplesRepo.pruneOlderThan(nowSec - USAGE_SAMPLE_RETENTION_SEC);
    } catch (e) {
      log.warn(`usage sampler failed: ${(e as Error).message}`);
    }
  };
  sampleUsage(); // 起動直後に 1 点打つ
  const usageSampleTimer = setInterval(sampleUsage, USAGE_SAMPLE_INTERVAL_MS);
  usageSampleTimer.unref?.();

  seedDefaultRules(rules);
  seedPersonas(personas);
  seedDelegationTemplates(delegationRepo);
  seedModelCatalog(modelCatalog);
  seedHarnessRules(harnessRepo);
  // 中央チャット描画 (Haiku). 「いつ / 誰が」 は決定的に決め、 発話文だけここで描画する。
  const renderConfig = () =>
    resolveRenderConfig({
      renderer: cfg.chatRenderer,
      model: cfg.chatModel,
    });
  const responder = new ChatResponder({
    chat,
    personas,
    sessions: repo,
    renderConfig,
    isChatMuted: () => adminState.getChatMuted(),
    isCostBlocked,
  });
  const dispatcher = new Dispatcher({
    sessions: repo,
    tasks,
    chat,
    responder,
    isChatMuted: () => adminState.getChatMuted(),
    isCostBlocked,
  });
  // 循環参照を遅延束縛: responder の投稿後 peer 返信ファンアウトを dispatcher に委ねる。
  responder.attachFanout(dispatcher);
  const processManager = new ProcessManager({
    repo: processes,
    logsDir: join(process.cwd(), "logs"),
  });

  const sweeper = startSweeper({
    repo,
    tasks,
    personas,
    dispatcher,
    intervalMs: cfg.sweeperIntervalMs,
    lostAfterSec: cfg.lostAfterSec,
    abandonedAfterSec: cfg.abandonedAfterSec,
    lostPurgeAfterSec: cfg.lostPurgeAfterSec,
    purgeAfterDays: cfg.purgeAfterDays,
  });

  // 孤児プロセス回収: 終了/消滅した session に紐付かない Lictor / agent-client を周期 kill。
  // sweeper が行を purge して記録が消えた分も OS 走査で回収する (止血は kill 経路の配線、 これは掃除)。
  const reaper = startReaper(
    { repo },
    {
      enabled: cfg.reaperEnabled,
      intervalMs: cfg.reaperIntervalMs,
      minAgeSec: cfg.reaperMinAgeSec,
      endedGraceSec: cfg.reaperEndedGraceSec,
    },
  );

  // PC パフォーマンス監視: ホストのメモリ/CPU + 上位プロセス + WSL/docker + セッション別 RSS を
  // 周期サンプリングして host_metrics に蓄積。 Monitor ページが最新スナップショットを表示する。
  const metricsStore = new MetricsStore(db);
  const metricsLoop = startMetricsLoop(
    { repo, store: metricsStore },
    {
      enabled: cfg.metricsEnabled,
      intervalMs: cfg.metricsIntervalMs,
      retentionHours: cfg.metricsRetentionHours,
    },
  );

  const toolPath = join(process.cwd(), "tools", "concordia-hook.mjs");
  const publicUrl = `http://${cfg.host}:${cfg.port}`;

  const dailyScheduler = startDailyScheduler({
    sessions: repo,
    dayReports,
  });

  // 毎朝 8 時に Memoria の今日期限タスクを取得し、Lictor セッションを起動して処理させる。
  // CONCORDIA_MEMORIA_URL で Memoria の URL を上書き可 (既定 http://127.0.0.1:5180)。
  const morningScheduler = startMorningScheduler({ delegationService });

  // 1 時間応答が無い (transcript 無更新) active セッションに「残作業を確認して続行 / 判断が
  // 要るなら ask で停止」 を inject する。 ask で人間判断待ちのセッションは踏み潰さないよう除外。
  const stallNudge = startStalledSessionNudge({
    repo,
    enabled: cfg.stallNudgeEnabled,
    intervalMs: cfg.stallNudgeIntervalMs,
    idleSec: cfg.stallIdleSec,
    cooldownSec: cfg.stallNudgeCooldownSec,
  });

  // 自動コンパクション: active セッションのコンテキスト占有 + 区切りを周期監視し、
  // 閾値超え/区切りで引き継ぎ型コンパクションを発火する。安全弁 CONCORDIA_AUTO_COMPACTION=1
  // (既定 OFF)。spec/feature/session-compaction.md
  const compactionIO = makeCompactionIO({ sessions: repo, chat });
  const autoCompaction = startAutoCompaction({
    sessions: repo,
    compact: (sessionId) =>
      runCompaction({ sessions: repo, transcriptLogs, runClaude, ...compactionIO }, sessionId),
    enabled: () => process.env.CONCORDIA_AUTO_COMPACTION === "1",
  });

  // observability (サービス監視 / catalog / auto-fix) は Excubitor (port 17332) に
  // 分離した (2026-05-31)。Concordia は AI 協調支援に専念。Vestigium ログ閲覧の
  // MCP だけ Concordia 同梱のまま (src/mcp/vestigium-*)。

  discordBotDeps = {
    db,
    chatRepo: chat,
    sessionsRepo: repo,
    sessionTaskRecordsRepo: sessionTaskRecords,
    tasksRepo: tasks,
    personasRepo: personas,
    prRecordsRepo: prs,
    // 本社モニターの「本社/子会社別コスト」用。 子会社 Bot は manager が baseDiscordDeps を
    // そのまま使うが、 monitor 側で subsidiary モード時は無視するので渡しても害は無い。
    listSubsidiaries: () =>
      subsidiaryRepo.list().map((s) => ({ id: s.id, name: s.display_name || s.name, daily_token_budget: s.daily_token_budget })),
    concordiaUrl: publicUrl,
    // リアクションワークフロー: ローカルクローン親 (Memoria 解決用) + 安全弁。
    // workspaceRoot は設定 GUI (AdminState) で上書き可能。 bot start のたびに live 値を読む。
    workspaceRoot: cfg.workspaceRoot || cfg.spawnDefaultCwd,
    resolveWorkspaceRoot: () => adminState.getWorkspaceRoot(),
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
    // 安全弁は AdminState (schema_meta) を毎回 live 評価 → 設定 GUI トグルが再起動なしで反映。
    resolveReactionWorkflowEnabled: () => adminState.getReactionWorkflowEnabled(),
    // ユーザ設定の 絵文字→アクション 上書き (設定 GUI) を live 反映。
    resolveReactionMappings: () => adminState.getReactionEmojiOverrides() as Record<string, WorkflowAction>,
    // start のたびに DB+env から実効設定を解決 → 設定変更後の restart で即反映。
    resolveConfig: () => resolveDiscordConfig(discordConfig, secretBox),
  };
  slackBotDeps = {
    db,
    chatRepo: chat,
    sessionsRepo: repo,
    personasRepo: personas,
    // cost Canvas の canvas_id 永続化 (slack_config key/value)。
    slackConfigRepo: slackConfig,
    concordiaUrl: publicUrl,
    // リアクションワークフロー (👍 → 実装着手 等): Discord と同じ安全弁 + ワークスペースルート。
    workspaceRoot: cfg.workspaceRoot || cfg.spawnDefaultCwd,
    resolveWorkspaceRoot: () => adminState.getWorkspaceRoot(),
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
    // 安全弁は AdminState (schema_meta) を毎回 live 評価 → 設定 GUI トグルが再起動なしで反映。
    resolveReactionWorkflowEnabled: () => adminState.getReactionWorkflowEnabled(),
    // ユーザ設定の 絵文字→アクション 上書き (設定 GUI) を live 反映。
    resolveReactionMappings: () => adminState.getReactionEmojiOverrides() as Record<string, WorkflowAction>,
    // start のたびに DB+env から実効設定を解決 → 設定変更後の restart で即反映。
    resolveConfig: () => resolveSlackConfig(slackConfig, secretBox),
  };

  // 子会社 Bot マネージャ。 本社 Discord bot と同じ共有 deps を base にし、 接続設定と
  // ガードゲートだけを子会社ごとに差し替えて startDiscordBot を子会社モードで起動する。
  const subsidiaryManager = new SubsidiaryBotManager({
    subsidiaryRepo,
    harnessRepo,
    delegationRepo,
    delegationService,
    // 子会社 Bot は本社と同じ application_id / bot token を使う (同一 Bot を別 guild に招待)。
    headOfficeDiscord: () => resolveDiscordConfig(discordConfig, secretBox),
    runClaude,
    budgetTracker: subsidiaryBudget,
    baseDiscordDeps: () => {
      // resolveConfig / subsidiary は manager が差し替えるので除く。
      const { resolveConfig: _rc, subsidiary: _sub, ...base } = discordBotDeps!;
      return base;
    },
  });

  const app = buildApp({
    repo,
    metrics: metricsStore,
    tasks,
    chat,
    skills,
    rules,
    dayReports,
    personas,
    processes,
    stats,
    prs,
    sessionTaskRecords,
    transcriptLogs,
    pendingQuestions,
    discordChannels,
    costSamples: usageSamplesRepo,
    costOneShots: costOneShotsRepo,
    discordConfig,
    participants,
    delegation: delegationRepo,
    delegationService,
    modelCatalog,
    subsidiary: subsidiaryRepo,
    harnessRules: harnessRepo,
    harnessAudit: harnessAuditRepo,
    harnessRunClaude: runClaude,
    subsidiaryManager,
    subsidiaryBudget,
    adminState,
    costStatus: () => costTracker.status(),
    processManager,
    dailyScheduler,
    dispatcher,
    config: cfg,
    startedAt: new Date().toISOString(),
    sweeperRunOnce: sweeper.runOnce,
    toolPath,
    publicUrl,
    discordAdmin: {
      start: startDiscordBotManaged,
      stop: stopDiscordBotManaged,
      restart: restartDiscordBotManaged,
    },
    slackConfig,
    secretBox,
    slackAdmin: {
      start: startSlackBotManaged,
      stop: stopSlackBotManaged,
      restart: restartSlackBotManaged,
    },
  });

  // ブラックボックス rule engine (決定的). 発火判定は LLM 不使用、 発話文は
  // 中央 Haiku レスポンダが描画する。 ルールは外部注入 + 決定的レビュー (api/rules) で増える。
  // 旧 rule proposer (5 分ごとの LLM 自動提案ループ) は撤去した。
  const ruleEngine = startRuleEngine({
    rules,
    sessions: repo,
    chat,
    responder,
    // 予算超過 / admin 無効化中は発火を止める。
    rulesDisabled: () => !adminState.getRulesEnabled() || isCostBlocked(),
  });

  // 10 分毎に active session に stat-collect を enqueue する scheduler.
  // フラットエージェントチームでの相互状況共有用 (各 session の現況を JSON で蓄積).
  // 同 scheduler が「5 分指示なし」 の idle トリガも兼任 (lastPrompt 起点で 1 stretch 1 回).
  const statScheduler = startStatScheduler({
    sessions: repo,
    stats,
    tasks,
  });

  // stat 受信時に repo_path 変化を検出して title-suggest を enqueue する watcher.
  // AI が 30 文字以内のサマリを投稿 → endpoint 側で Lictor /v1/rename に転送.
  const repoChangeWatcher = startRepoChangeWatcher({
    sessions: repo,
    tasks,
  });

  // PR キュー: stat.collected を購読して open_prs[] を pr_records に派生 UPSERT (方式 A).
  const prIngestWatcher = startPrIngestWatcher({ sessions: repo, stats, personas, prs });
  // PR キュー: gh で merged/closed/ci/review を確定する reconcile tick (方式 C).
  const prReconciler = startPrReconciler({ prs, sessions: repo });
  // PR キュー: gh search で org の open PR を全件発見し未登録分を取り込む (方式 D)。
  // これで「誰も報告していない open PR」も Queue に出る。state/ci/review は reconcile が確定。
  const prFullSync = startPrFullSync({ prs });

  // エラー自動修正: error.reported を購読し、 常駐 error-fixer Codex に修正依頼を inject.
  // env CONCORDIA_ERROR_AUTOFIX=1 の時だけ稼働 (既定 OFF).
  const errorFixDispatcher = startErrorFixDispatcher({ sessions: repo, spawnDefaultCwd: cfg.spawnDefaultCwd });

  const server = serve({
    fetch: app.fetch,
    hostname: cfg.host,
    port: cfg.port,
  });

  // WebSocket broadcast (/ws). eventBus を全 connected client に流す.
  // `?session=<id>` で接続された WS は sessions.ws_clients をインクリメント →
  // 切断でデクリメント. sweeper の lost 判定からは ws_clients > 0 の session が除外される.
  // serve() は Http2Server | http.Server union を返すが Concordia は HTTP/1.1 で起動するので http.Server.
  const ws = attachWsServer(server as unknown as HttpServer, "/ws", repo);

  // 動作ログ的な event を 1 active peer に exclusive 通知 (peer-log-react task).
  // dispatcher 側で 60s cooldown + round-robin で 1 peer 選択 → pending_tasks の delivered_at で排他成立.
  const unsubLog = eventBus.subscribe((ev) => {
    // ぼやき投稿は投稿者セッションの persona 情報 (feedback log) に収集する.
    if (ev.type === "chat.posted") {
      if (ev.channel === "ぼやき") {
        collectBoyakiToPersona(
          { personas, chat },
          { message_id: ev.message_id, session_id: ev.session_id ?? null },
        );
      }
      return;
    }
    if (ev.type === "rule.changed" && (ev.action === "add" || ev.action === "remove")) {
      dispatcher.onLogUpdate({
        kind: ev.action === "add" ? "rule.add" : "rule.remove",
        ref: ev.rule_id,
        summary: `rule "${ev.rule_id ?? "?"}" が ${ev.action} されました.`,
      });
      return;
    }
    if (ev.type === "session.started") {
      dispatcher.onLogUpdate({
        kind: "session.started",
        source_session_id: ev.session_id,
        ref: ev.session_id,
        summary: `新セッション開始: ${ev.session_id.slice(0, 8)} (${ev.provider}, branch=${ev.branch ?? "-"}).`,
        detail: { repo_path: ev.repo_path, provider: ev.provider, branch: ev.branch },
      });
      return;
    }
    if (ev.type === "skill.snapshot" && ev.poison_score >= 0.3) {
      dispatcher.onLogUpdate({
        kind: "skill.poison-spike",
        ref: `${ev.skill_name}@${ev.repo_path}`,
        summary:
          `skill ${ev.skill_name} の poison_score=${(ev.poison_score * 100).toFixed(0)}% (repo=${ev.repo_path}). 内容を確認推奨.`,
        detail: { repo_path: ev.repo_path, skill_name: ev.skill_name, poison_score: ev.poison_score },
      });
    }
  });

  log.info(
    {
      host: cfg.host,
      port: cfg.port,
      dbPath,
      llm: "cli (claude -p)",
    },
    "Concordia listening",
  );

  // RWF (Reaction-WorkFlow) プラグインを bots 起動前に読み込む。 外部プラグイン
  // (Concordia-RWF) が在れば動的 import、 無ければ同梱エンジンにフォールバック。
  await initReactionWorkflow(workspaceRootDefault, log);

  // Discord-UI bot. CONCORDIA_DISCORD_ENABLED が無ければ完全 no-op (= 既存運用に影響なし).
  // spec/discord-ui.md
  {
    const started = await startDiscordBotManaged();
    if (!started.ok) log.warn(`Discord bot init failed: ${started.error ?? "unknown"}`);
  }

  // Slack-UI bot（Discord と並ぶ ChatPlatform）。CONCORDIA_SLACK_ENABLED が
  // 無ければ完全 no-op。spec/feature/slack-platform.md
  {
    const started = await startSlackBotManaged();
    if (!started.ok) log.warn(`Slack bot init failed: ${started.error ?? "unknown"}`);
  }

  // 子会社 Bot: enabled な子会社を一括起動 (本社 bot と同じ 3 カテゴリ自動作成 +
  // subsidiary-only 可視 + ガードゲート)。 spec/feature/subsidiary-delegation.md
  await subsidiaryManager.startAll().catch((e) => log.warn(`subsidiary bots init failed: ${(e as Error).message}`));

  return {
    port: cfg.port,
    shutdown: async () => {
      dailyScheduler.stop();
      morningScheduler.stop();
      ruleEngine.stop();
      statScheduler.stop();
      repoChangeWatcher.stop();
      prIngestWatcher.stop();
      prReconciler.stop();
      prFullSync.stop();
      errorFixDispatcher.stop();
      sweeper.stop();
      reaper.stop();
      stallNudge.stop();
      autoCompaction.stop();
      metricsLoop.stop();
      clearInterval(costSampleTimer);
      clearInterval(usageSampleTimer);
      unsubLog();
      await stopDiscordBotManaged();
      await stopSlackBotManaged();
      await subsidiaryManager.stopAll();
      await processManager.stopAll();
      ws.close();
      server.close();
      closeDb();
    },
  };
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1] ?? "";
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  const url = import.meta.url;
  return url === `file://${norm}` || url === `file:///${norm}` || url.endsWith(norm);
}

if (isEntrypoint()) {
  startBackend().catch((err) => {
    log.error({ err }, "Concordia failed to start");
    process.exit(1);
  });
}
