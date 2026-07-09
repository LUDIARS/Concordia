/**
 * Concordia backend エントリポイント.
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, isLoopbackHost } from "../shared/config.js";
import { createChildLogger } from "../shared/logger.js";
import { openDb, closeDb } from "../db/index.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { makeParticipantsRepo } from "../db/participants-repo.js";
import { TasksRepo } from "../db/tasks-repo.js";
import { ChatRepo } from "../db/chat-repo.js";
import { SkillsRepo } from "../db/skills-repo.js";
import { RulesRepo, seedDefaultRules } from "../db/rules-repo.js";
import { DayReportsRepo } from "../db/day-reports-repo.js";
import { PersonasRepo } from "../db/personas-repo.js";
import { ProcessesRepo } from "../db/processes-repo.js";
import { StatsRepo } from "../db/stats-repo.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import {
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
  makeDiscordConfigRepo,
} from "../db/discord-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { DelegationService } from "../delegation/service.js";
import { seedDelegationTemplates } from "../delegation/seed.js";
import { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import { seedModelCatalog } from "../model-catalog/seed.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { createHarnessBlackbox } from "../harness/blackbox-engine.js";
import { seedHarnessRules } from "../subsidiary/harness-seed.js";
import { SubsidiaryBotManager } from "../subsidiary/manager.js";
import { SubsidiaryBudgetTracker } from "../subsidiary/budget.js";
import { runClaude } from "../rules/claude-runner.js";
import { repinSession } from "../control/repin-session.js";
import { AdminState } from "../admin/state.js";
import { setLictorLauncherResolver, setConcordiaAddress } from "../control/spawner.js";
import { resolveLictorLauncher } from "../control/lictor-launcher.js";
import type { WorkflowAction } from "../platform/reaction-workflow.js";
import { ProcessManager } from "../processes/manager.js";
import { seedPersonas } from "../personas/seeds.js";
import { collectBoyakiToPersona } from "../personas/boyaki.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { startBranchWatch } from "../testing/branch-watch.js";
import { startSweeper } from "../sweeper.js";
import { startReaper } from "../control/reaper.js";
import { startStalledSessionNudge } from "../control/stalled-session-nudge.js";
import { startIdleNudge } from "../control/idle-nudge.js";
import { startAutoCompaction } from "../control/auto-compaction.js";
import { runCompaction, makeCompactionIO } from "../control/compaction.js";
import { MetricsStore } from "../metrics/store.js";
import { startMetricsLoop } from "../metrics/loop.js";
import { startRuleEngine } from "../rules/engine.js";
import { startDailyScheduler } from "../daily/scheduler.js";
import { startMorningScheduler } from "../morning/scheduler.js";
import { startStatScheduler } from "../stat/scheduler.js";
import { startRepoChangeWatcher } from "../stat/repo-change-watcher.js";
import { startPrIngestWatcher } from "../pr/ingest.js";
import { startPrReconciler } from "../pr/reconcile.js";
import { startPrFullSync } from "../pr/full-sync.js";
import { startErrorFixDispatcher } from "../control/error-fix.js";
import { buildApp } from "../app.js";
import { attachWsServer } from "../api/ws.js";
import { eventBus } from "../events.js";
import type { DiscordBotDeps, DiscordBotHandle } from "../discord/bot.js";
import { startDiscordBot } from "../discord/bot.js";
import { initReactionWorkflow } from "../platform/reaction-workflow-loader.js";
import type { SlackBotDeps } from "../slack/bot.js";
import { startSlackBot } from "../slack/bot.js";
import { makeChatReadModel } from "../api/chat-read-models.js";
import { makeSlackConfigRepo } from "../db/slack-config-repo.js";
import { resolveSlackConfig } from "../slack/config.js";
import { resolveDiscordConfig } from "../discord/conn-config.js";
import { loadSecretBox } from "../shared/secret-box.js";
import type { BotRuntimeStatus } from "../api/platform-runtime-status.js";
import type { ChatPlatform } from "../platform/chat-platform.js";
import { chatEmbeddedEnabled, readChatMode } from "./chat.js";
import {
  COST_WORKER_CHECK_MS,
  costEmbeddedEnabled,
  createCostRuntime,
  readCostMode,
  readCostWorkerLease,
} from "./cost.js";

const log = createChildLogger("server");

let discordBotHandle: DiscordBotHandle | null = null;
let discordBotDeps: DiscordBotDeps | null = null;
let slackBotHandle: ChatPlatform | null = null;
let slackBotDeps: SlackBotDeps | null = null;
let discordBotLastStatus: string | null = "not_started";
let discordBotLastError: string | null = null;
let slackBotLastStatus: string | null = "not_started";
let slackBotLastError: string | null = null;

function discordEmbeddedEnabled(): boolean {
  return chatEmbeddedEnabled() && process.env.CONCORDIA_DISCORD_EMBEDDED !== "0";
}

function discordSubsidiaryAutostartEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.CONCORDIA_DISCORD_SUBSIDIARY_AUTOSTART ?? "");
}

function rememberDiscordBotResult<const T extends { ok: boolean; status: string; error?: string }>(result: T): T {
  discordBotLastStatus = result.status;
  discordBotLastError = result.ok ? null : result.error ?? null;
  return result;
}

function rememberSlackBotResult<const T extends { ok: boolean; status: string; error?: string }>(result: T): T {
  slackBotLastStatus = result.status;
  slackBotLastError = result.ok ? null : result.error ?? null;
  return result;
}

function discordBotRuntimeStatus(): BotRuntimeStatus {
  return {
    running: !!discordBotHandle,
    embedded_enabled: discordEmbeddedEnabled(),
    last_status: discordBotLastStatus,
    last_error: discordBotLastError,
  };
}

function slackBotRuntimeStatus(): BotRuntimeStatus {
  return {
    running: !!slackBotHandle,
    embedded_enabled: chatEmbeddedEnabled(),
    last_status: slackBotLastStatus,
    last_error: slackBotLastError,
  };
}

async function startSlackBotManaged(): Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }> {
  if (!chatEmbeddedEnabled()) return rememberSlackBotResult({ ok: true, status: "disabled" });
  if (slackBotHandle) return rememberSlackBotResult({ ok: true, status: "already_running" });
  if (!slackBotDeps) return rememberSlackBotResult({ ok: false, status: "error", error: "slack deps not initialized" });
  try {
    const h = await startSlackBot(slackBotDeps);
    if (!h) return rememberSlackBotResult({ ok: true, status: "disabled" });
    slackBotHandle = h;
    return rememberSlackBotResult({ ok: true, status: "started" });
  } catch (e) {
    return rememberSlackBotResult({ ok: false, status: "error", error: (e as Error).message });
  }
}

async function stopSlackBotManaged(): Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }> {
  if (!slackBotHandle) return rememberSlackBotResult({ ok: true, status: "already_stopped" });
  try {
    await slackBotHandle.stop();
    slackBotHandle = null;
    return rememberSlackBotResult({ ok: true, status: "stopped" });
  } catch (e) {
    return rememberSlackBotResult({ ok: false, status: "error", error: (e as Error).message });
  }
}

async function restartSlackBotManaged(): Promise<{ ok: boolean; status: "restarted" | "started" | "disabled" | "error"; error?: string }> {
  const stop = await stopSlackBotManaged();
  if (!stop.ok) return rememberSlackBotResult({ ok: false, status: "error", error: stop.error });
  const start = await startSlackBotManaged();
  if (!start.ok) return rememberSlackBotResult({ ok: false, status: "error", error: start.error });
  if (start.status === "disabled") return rememberSlackBotResult({ ok: true, status: "disabled" });
  return rememberSlackBotResult({ ok: true, status: stop.status === "already_stopped" ? "started" : "restarted" });
}

async function startDiscordBotManaged(): Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }> {
  if (!discordEmbeddedEnabled()) return rememberDiscordBotResult({ ok: true, status: "disabled" });
  if (discordBotHandle) return rememberDiscordBotResult({ ok: true, status: "already_running" });
  if (!discordBotDeps) return rememberDiscordBotResult({ ok: false, status: "error", error: "discord deps not initialized" });
  try {
    rememberDiscordBotResult({ ok: true, status: "starting" });
    const h = await startDiscordBot(discordBotDeps);
    if (!h) return rememberDiscordBotResult({ ok: true, status: "disabled" });
    discordBotHandle = h;
    return rememberDiscordBotResult({ ok: true, status: "started" });
  } catch (e) {
    return rememberDiscordBotResult({ ok: false, status: "error", error: (e as Error).message });
  }
}

async function stopDiscordBotManaged(): Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }> {
  if (!discordBotHandle) return rememberDiscordBotResult({ ok: true, status: "already_stopped" });
  try {
    await discordBotHandle.stop();
    discordBotHandle = null;
    return rememberDiscordBotResult({ ok: true, status: "stopped" });
  } catch (e) {
    return rememberDiscordBotResult({ ok: false, status: "error", error: (e as Error).message });
  }
}

async function restartDiscordBotManaged(): Promise<{ ok: boolean; status: "restarted" | "started" | "disabled" | "error"; error?: string }> {
  const stop = await stopDiscordBotManaged();
  if (!stop.ok) return rememberDiscordBotResult({ ok: false, status: "error", error: stop.error });
  const start = await startDiscordBotManaged();
  if (!start.ok) return rememberDiscordBotResult({ ok: false, status: "error", error: start.error });
  if (start.status === "disabled") return rememberDiscordBotResult({ ok: true, status: "disabled" });
  return rememberDiscordBotResult({ ok: true, status: stop.status === "already_stopped" ? "started" : "restarted" });
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

export function readPersonaInjectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONCORDIA_PERSONA_INJECT === "1";
}

export function readCcWorkflowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONCORDIA_CC_WORKFLOW === "1";
}

export interface BackendHandle {
  port: number;
  shutdown: () => Promise<void>;
}

interface StoppableHandle {
  stop: () => void;
}

export async function startBackend(): Promise<BackendHandle> {
  const bootStarted = Date.now();
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
  const harnessBlackbox = createHarnessBlackbox(db);
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
    personaInjectEnabled: readPersonaInjectEnabled(),
    ccWorkflowEnabled: readCcWorkflowEnabled(),
    // dev モードの Lictor リポ既定 (= <workspaceRoot>/Lictor)。 空でも GUI で設定可。
    lictorDevPath: workspaceRootDefault ? join(workspaceRootDefault, "Lictor") : "",
  });
  // spawn の Lictor launcher を AdminState 設定から live 解決する (dev/prod/auto)。
  setLictorLauncherResolver(() => resolveLictorLauncher(adminState));
  // spawn する Lictor が必ず spawning Concordia を指すよう、 自分の listen アドレスを
  // env 継承ではなく CONCORDIA_HOST / CONCORDIA_PORT として明示注入する。
  setConcordiaAddress(() => ({ host: cfg.host, port: cfg.port }));

  // テスト交通整備: 起動テスト/再起動の宣言レジストリ (/v1/testing) + ブランチ切替
  // 監視 inject。 spec/feature/testing-traffic.md
  const testingClaims = new TestingClaimsRepo(db);
  // セッション終了/喪失で claim を自動解放 (放置クレームの残留防止)。
  const unsubTestingRelease = eventBus.subscribe((ev) => {
    if (ev.type === "session.ended" || ev.type === "session.lost") {
      try {
        testingClaims.release(ev.session_id, null, Math.floor(Date.now() / 1000));
      } catch { /* best-effort */ }
    }
  });

  // コスト予算 (日次トークン上限) — 全ログ走査でトークン消費を蓄積し、 超過で
  // Concordia 発の命令 (spawn / dispatcher / rule engine / proposer) を止める。
  const costRuntime = createCostRuntime({
    db,
    sessionsRepo: repo,
    getDailyTokenBudget: () => adminState.getDailyTokenBudget(),
    log,
  });
  const costMode = readCostMode();
  const usageSamplesRepo = costRuntime.usageSamplesRepo;
  const costLimitSamplesRepo = costRuntime.limitSamplesRepo;
  const costOneShotsRepo = costRuntime.oneShotsRepo;
  const isCostBlocked = () => (costMode === "off" ? false : costRuntime.tracker.isBlocked());

  if (costEmbeddedEnabled()) {
    if (readCostWorkerLease(discordConfig)) {
      log.info("cost embedded sampler skipped: live cost-worker lease found");
    } else {
      costRuntime.start();
    }
  } else if (costMode === "worker") {
    log.info("cost embedded sampler disabled; run `npm run cost:worker` as a separate process");
  } else {
    log.info("cost sampling disabled by CONCORDIA_COST_MODE=off");
  }

  const processManager = new ProcessManager({
    repo: processes,
    logsDir: join(process.cwd(), "logs"),
  });

  const sweeper = startSweeper({
    repo,
    tasks,
    personas,
    intervalMs: cfg.sweeperIntervalMs,
    lostAfterSec: cfg.lostAfterSec,
    abandonedAfterSec: cfg.abandonedAfterSec,
    lostPurgeAfterSec: cfg.lostPurgeAfterSec,
    purgeAfterDays: cfg.purgeAfterDays,
  });

  // 孤児プロセス回収: 終了/消滅した session に紐付かない Lictor / agent-client を周期 kill。
  // sweeper が行を purge して記録が消えた分も OS 走査で回収する (止血は kill 経路の配線、 これは掃除)。
  // PC パフォーマンス監視: ホストのメモリ/CPU + 上位プロセス + WSL/docker + セッション別 RSS を
  // 周期サンプリングして host_metrics に蓄積。 Monitor ページが最新スナップショットを表示する。
  const metricsStore = new MetricsStore(db);
  const toolPath = join(process.cwd(), "tools", "concordia-hook.mjs");
  const publicUrl = `http://${cfg.host}:${cfg.port}`;

  const dailyScheduler = startDailyScheduler({
    sessions: repo,
    dayReports,
  });

  // 毎朝 8 時に Memoria の今日期限タスクを取得し、Lictor セッションを起動して処理させる。
  // CONCORDIA_MEMORIA_URL で Memoria の URL を上書き可 (既定 http://127.0.0.1:5180)。
  // 1 時間応答が無い (transcript 無更新) active セッションに「残作業を確認して続行 / 判断が
  // 要るなら ask で停止」 を inject する。 ask で人間判断待ちのセッションは踏み潰さないよう除外。
  // 自動コンパクション: active セッションのコンテキスト占有 + 区切りを周期監視し、
  // 閾値超え/区切りで引き継ぎ型コンパクションを発火する。安全弁 CONCORDIA_AUTO_COMPACTION=1
  // (既定 OFF)。spec/feature/session-compaction.md
  const compactionIO = makeCompactionIO({ sessions: repo, chat });
  const chatReadModel = makeChatReadModel({
    chatRepo: chat,
    sessionsRepo: repo,
    personasRepo: personas,
    sessionTaskRecordsRepo: sessionTaskRecords,
    tasksRepo: tasks,
    prRecordsRepo: prs,
  });

  // observability (サービス監視 / catalog / auto-fix) は Excubitor (port 17332) に
  // 分離した (2026-05-31)。Concordia は AI 協調支援に専念。Vestigium ログ閲覧の
  // MCP だけ Concordia 同梱のまま (src/mcp/vestigium-*)。

  discordBotDeps = {
    db,
    readModel: chatReadModel,
    chatRepo: chat,
    sessionsRepo: repo,
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
    runHeadless: runClaude,
    repinSession: (sessionId) => repinSession(repo, sessionId),
    onRuntimeState: (state) => {
      discordBotLastStatus = state.status;
      discordBotLastError = state.error ?? null;
      if (!state.running) discordBotHandle = null;
    },
    // start のたびに DB+env から実効設定を解決 → 設定変更後の restart で即反映。
    resolveConfig: () => resolveDiscordConfig(discordConfig, secretBox),
  };
  slackBotDeps = {
    db,
    readModel: chatReadModel,
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
    runHeadless: runClaude,
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
    startBot: (deps) => startDiscordBot(deps as DiscordBotDeps),
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
    costLimitSamples: costLimitSamplesRepo,
    costOneShots: costOneShotsRepo,
    discordConfig,
    participants,
    delegation: delegationRepo,
    delegationService,
    modelCatalog,
    testingClaims,
    subsidiary: subsidiaryRepo,
    harnessRules: harnessRepo,
    harnessAudit: harnessAuditRepo,
    harnessRunClaude: runClaude,
    harnessBlackbox,
    subsidiaryManager,
    subsidiaryBudget,
    adminState,
    costStatus: () => costRuntime.tracker.status(),
    costOverviewSource: costMode === "worker" ? "samples" : "live",
    processManager,
    dailyScheduler,
    config: cfg,
    startedAt: new Date().toISOString(),
    sweeperRunOnce: sweeper.runOnce,
    toolPath,
    publicUrl,
    discordAdmin: {
      start: startDiscordBotManaged,
      stop: stopDiscordBotManaged,
      restart: restartDiscordBotManaged,
      status: discordBotRuntimeStatus,
    },
    slackConfig,
    secretBox,
    slackAdmin: {
      start: startSlackBotManaged,
      stop: stopSlackBotManaged,
      restart: restartSlackBotManaged,
      status: slackBotRuntimeStatus,
    },
    chatRoutes: readChatMode() === "off" ? null : undefined,
    costRoutes: costMode === "off" ? null : undefined,
  });

  // ブラックボックス rule engine (決定的). 発火判定は LLM 不使用、 発話文は
  // 中央 Haiku レスポンダが描画する。 ルールは外部注入 + 決定的レビュー (api/rules) で増える。
  // 旧 rule proposer (5 分ごとの LLM 自動提案ループ) は撤去した。
    // 予算超過 / admin 無効化中は発火を止める。
  // 10 分毎に active session に stat-collect を enqueue する scheduler.
  // フラットエージェントチームでの相互状況共有用 (各 session の現況を JSON で蓄積).
  // 同 scheduler が「5 分指示なし」 の idle トリガも兼任 (lastPrompt 起点で 1 stretch 1 回).
  // stat 受信時に repo_path 変化を検出して title-suggest を enqueue する watcher.
  // AI が 30 文字以内のサマリを投稿 → endpoint 側で Lictor /v1/rename に転送.
  // PR キュー: stat.collected を購読して open_prs[] を pr_records に派生 UPSERT (方式 A).
  // PR キュー: gh で merged/closed/ci/review を確定する reconcile tick (方式 C).
  // PR キュー: gh search で org の open PR を全件発見し未登録分を取り込む (方式 D)。
  // これで「誰も報告していない open PR」も Queue に出る。state/ci/review は reconcile が確定。

  // エラー自動修正: error.reported を購読し、 常駐 error-fixer Codex に修正依頼を inject.
  // env CONCORDIA_ERROR_AUTOFIX=1 の時だけ稼働 (既定 OFF).
  const server = serve({
    fetch: app.fetch,
    hostname: cfg.host,
    port: cfg.port,
  });
  server.ref?.();

  // listen エラー (EADDRINUSE 等) は serve() の後に非同期で http server へ emit される。
  // ハンドラが無いと ws (attachWsServer) が wss へ転送 → 未捕捉 'error' イベントで
  // ハードクラッシュする (二重起動の典型: 既存 Concordia がポートを占有)。 ここで捕捉して
  // 原因を一行で明示し、 きれいに exit する (serve() 後の非同期エラーなので startBackend()
  // の .catch では拾えない)。 'listening' より前に登録するため serve() 直後に置く。
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        { host: cfg.host, port: cfg.port },
        `ポート ${cfg.host}:${cfg.port} は既に使用中です。 Concordia が既に起動しているか、 別プロセスがポートを占有しています。 既存プロセスを停止してから再起動してください。`,
      );
    } else {
      log.error({ err }, "Concordia HTTP server failed to listen");
    }
    process.exit(1);
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
  });

  // 実際に bind 成功した時だけ "listening" を出す。 以前は serve() 直後に無条件で
  // log していたため、 EADDRINUSE で落ちる時も「listening」 が先に出てエラーが
  // 埋もれていた (二重起動時に「起動したのに落ちる」 ように見える原因)。
  let shuttingDown = false;
  let postListenStartup: Promise<void> = Promise.resolve();
  const postListenHandles: StoppableHandle[] = [];

  function trackPostListenHandle<T extends StoppableHandle>(handle: T): T {
    postListenHandles.push(handle);
    return handle;
  }

  function startPostListenBackground(): void {
    if (shuttingDown) return;
    trackPostListenHandle(startBranchWatch({ sessions: repo, claims: testingClaims, log }));
    trackPostListenHandle(
      startReaper(
        { repo },
        {
          enabled: cfg.reaperEnabled,
          intervalMs: cfg.reaperIntervalMs,
          minAgeSec: cfg.reaperMinAgeSec,
          endedGraceSec: cfg.reaperEndedGraceSec,
        },
      ),
    );
    trackPostListenHandle(
      startMetricsLoop(
        { repo, store: metricsStore },
        {
          enabled: cfg.metricsEnabled,
          intervalMs: cfg.metricsIntervalMs,
          retentionHours: cfg.metricsRetentionHours,
        },
      ),
    );
    trackPostListenHandle(startMorningScheduler({ delegationService }));
    trackPostListenHandle(
      startStalledSessionNudge({
        repo,
        enabled: cfg.stallNudgeEnabled,
        intervalMs: cfg.stallNudgeIntervalMs,
        idleSec: cfg.stallIdleSec,
        cooldownSec: cfg.stallNudgeCooldownSec,
      }),
    );
    trackPostListenHandle(
      startIdleNudge({
        repo,
        seconds: cfg.idleNudgeSec,
        postToSession: async (input) => {
          const posts: Array<Promise<void>> = [];
          if (discordBotHandle) posts.push(discordBotHandle.postToSession(input));
          if (slackBotHandle) posts.push(slackBotHandle.postToSession(input));
          await Promise.all(posts);
        },
        log: {
          info: (message) => log.info(message),
          warn: (message) => log.warn(message),
        },
      }),
    );
    trackPostListenHandle(
      startAutoCompaction({
        sessions: repo,
        compact: (sessionId) =>
          runCompaction({ sessions: repo, transcriptLogs, runClaude, ...compactionIO }, sessionId),
        enabled: () => process.env.CONCORDIA_AUTO_COMPACTION === "1",
      }),
    );
    trackPostListenHandle(
      startRuleEngine({
        rules,
        sessions: repo,
        rulesDisabled: () => !adminState.getRulesEnabled() || isCostBlocked(),
      }),
    );
    trackPostListenHandle(startStatScheduler({ sessions: repo, stats, tasks }));
    trackPostListenHandle(startRepoChangeWatcher({ sessions: repo, tasks }));
    trackPostListenHandle(startPrIngestWatcher({ sessions: repo, stats, personas, prs }));
    trackPostListenHandle(startPrReconciler({ prs, sessions: repo, tasks }));
    trackPostListenHandle(startPrFullSync({ prs }));
    trackPostListenHandle(startErrorFixDispatcher({ sessions: repo, spawnDefaultCwd: cfg.spawnDefaultCwd }));
  }

  server.on("listening", () => {
    const bootMs = Date.now() - bootStarted;
    const payload = {
      host: cfg.host,
      port: cfg.port,
      dbPath,
      llm: "cli (claude -p)",
      boot_ms: bootMs,
    };
    if (bootMs >= readNonNegativeIntEnv("CONCORDIA_BOOT_WARN_MS", 60)) {
      log.warn(payload, "Concordia listening");
    } else {
      log.info(payload, "Concordia listening");
    }
    postListenStartup = runPostListenStartup().catch((e) =>
      log.warn(`post-listen integrations init failed: ${(e as Error).message}`),
    );
  });

  // RWF (Reaction-WorkFlow) プラグインを bots 起動前に読み込む。 外部プラグイン
  // (Concordia-RWF) が在れば動的 import、 無ければ同梱エンジンにフォールバック。
  async function runPostListenStartup(): Promise<void> {
    const startedAt = Date.now();
    await delay(readNonNegativeIntEnv("CONCORDIA_POST_LISTEN_STARTUP_DELAY_MS", 250));
    if (shuttingDown) return;

    seedDefaultRules(rules);
    seedPersonas(personas);
    seedDelegationTemplates(delegationRepo);
    seedModelCatalog(modelCatalog);
    seedHarnessRules(harnessRepo);
    if (shuttingDown) return;

    const resetCount = repo.resetAllWsClients();
    if (resetCount > 0) {
      log.info({ count: resetCount }, "ws_clients reset after listen");
    }
    startPostListenBackground();
    if (shuttingDown) return;
    await initReactionWorkflow(workspaceRootDefault, log);
    if (shuttingDown) return;

  // Discord-UI bot. CONCORDIA_DISCORD_ENABLED が無ければ完全 no-op (= 既存運用に影響なし).
  // spec/discord-ui.md
  {
    if (discordEmbeddedEnabled()) {
      rememberDiscordBotResult({ ok: true, status: "starting" });
      void startDiscordBotManaged()
        .then((started) => {
          if (!started.ok) log.warn(`Discord bot init failed: ${started.error ?? "unknown"}`);
        })
        .catch((e) => log.warn(`Discord bot init failed: ${(e as Error).message}`));
    } else {
      log.info("Discord embedded bot disabled (CONCORDIA_CHAT_MODE=off / CONCORDIA_DISCORD_EMBEDDED=0)");
    }
  }
  if (shuttingDown) return;

  const slackStarted = await startSlackBotManaged();
  if (!slackStarted.ok) log.warn(`Slack bot init failed: ${slackStarted.error ?? "unknown"}`);
  if (shuttingDown) return;

  if (discordEmbeddedEnabled()) {
    if (discordSubsidiaryAutostartEnabled()) {
      await subsidiaryManager.startAll();
    } else {
      log.info("Discord subsidiary autostart disabled (CONCORDIA_DISCORD_SUBSIDIARY_AUTOSTART != 1)");
    }
  }
  log.info({ duration_ms: Date.now() - startedAt }, "post-listen integrations started");
  }

  const costWorkerWatch = setInterval(() => {
    if (!costRuntime.isRunning() || !readCostWorkerLease(discordConfig)) return;
    log.warn("live cost-worker lease detected; stopping embedded cost sampler");
    costRuntime.stop();
  }, COST_WORKER_CHECK_MS);
  costWorkerWatch.unref?.();

  // Slack-UI bot（Discord と並ぶ ChatPlatform）。CONCORDIA_SLACK_ENABLED が
  // 無ければ完全 no-op。spec/feature/slack-platform.md

  // 子会社 Bot: enabled な子会社を一括起動 (本社 bot と同じ 3 カテゴリ自動作成 +
  // subsidiary-only 可視 + ガードゲート)。 spec/feature/subsidiary-delegation.md

  return {
    port: cfg.port,
    shutdown: async () => {
      shuttingDown = true;
      dailyScheduler.stop();
      sweeper.stop();
      for (const handle of postListenHandles.splice(0).reverse()) {
        try {
          handle.stop();
        } catch (e) {
          log.warn(`post-listen handle stop failed: ${(e as Error).message}`);
        }
      }
      unsubTestingRelease();
      clearInterval(costWorkerWatch);
      costRuntime.stop();
      unsubLog();
      await postListenStartup.catch(() => {});
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

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
