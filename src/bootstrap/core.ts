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
import { ControlJobsRepo } from "../db/control-jobs-repo.js";
import { makeParticipantsRepo } from "../db/participants-repo.js";
import { TasksRepo } from "../db/tasks-repo.js";
import { ChatRepo } from "../db/chat-repo.js";
import { SkillsRepo } from "../db/skills-repo.js";
import { RulesRepo, seedDefaultRules } from "../db/rules-repo.js";
import { DayReportsRepo } from "../db/day-reports-repo.js";
import { ProcessesRepo } from "../db/processes-repo.js";
import { StatsRepo } from "../db/stats-repo.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import { SessionMessagesRepo } from "../db/session-messages-repo.js";
import { SessionMessageReadsRepo } from "../db/session-message-reads-repo.js";
import { WebPushRepo } from "../db/web-push-repo.js";
import { SessionMessageService } from "../messages/service.js";
import { WebPushService } from "../push/service.js";
import {
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
  makeDiscordConfigRepo,
} from "../db/discord-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { DelegationService } from "../delegation/service.js";
import { DelegationEffortBlackbox } from "../delegation/effort-blackbox.js";
import { DelegationQueue } from "../delegation/queue.js";
import { DEFAULT_DESK_CHANNEL_NAME } from "../discord/config.js";
import { seedDelegationTemplates } from "../delegation/seed.js";
import { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import { seedModelCatalog } from "../model-catalog/seed.js";
import { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { createHarnessBlackbox } from "../harness/blackbox-engine.js";
import { seedHarnessRules } from "../subsidiary/harness-seed.js";
import { InjectManualsRepo } from "../db/inject-manuals-repo.js";
import { seedInjectManuals } from "../control/inject-manual-seed.js";
import { answerPendingQuestion, questionStoreFromRepo } from "../control/answer-question.js";
import { SubsidiaryBotManager } from "../subsidiary/manager.js";
import { SubsidiaryBudgetTracker } from "../subsidiary/budget.js";
import { runClaude } from "../rules/claude-runner.js";
import { repinSession } from "../control/repin-session.js";
import { AdminState } from "../admin/state.js";
import {
  resolveAgentHomeCwd,
  setLictorLauncherResolver,
  setConcordiaAddress,
  setWorkspaceRootsResolver,
} from "../control/spawner.js";
import { resolveLictorLauncher } from "../control/lictor-launcher.js";
import type { WorkflowAction } from "../platform/reaction-workflow.js";
import { ProcessManager } from "../processes/manager.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { releaseTestingClaims } from "../testing/claim-lifecycle.js";
import { startBranchWatch } from "../testing/branch-watch.js";
import { startEndSessionRequestWatch } from "../control/end-session-request.js";
import { endSessionNow } from "../control/end-session-command.js";
import { startSweeper } from "../sweeper.js";
import { startReaper } from "../control/reaper.js";
import { startStalledSessionNudge } from "../control/stalled-session-nudge.js";
import { startDelegationRunWatchdog } from "../delegation/run-watchdog.js";
import { startIdleNudge } from "../control/idle-nudge.js";
import { startGoalAndGo } from "../control/goal-and-go.js";
import { pendingQuestionProbe } from "../control/pending-question-blocker.js";
import { startAutoCompaction } from "../control/auto-compaction.js";
import { runCompaction, makeCompactionIO } from "../control/compaction.js";
import { MetricsStore } from "../metrics/store.js";
import { startMetricsLoop } from "../metrics/loop.js";
import { startRuleEngine } from "../rules/engine.js";
import { startDailyScheduler } from "../daily/scheduler.js";
import { startMorningScheduler } from "../morning/scheduler.js";
import { startCronScheduler } from "../scheduler/cron-scheduler.js";
import { startStatScheduler } from "../stat/scheduler.js";
import { startRepoChangeWatcher } from "../stat/repo-change-watcher.js";
import { startPrIngestWatcher } from "../pr/ingest.js";
import { startPrReconciler } from "../pr/reconcile.js";
import { createRevisorClientFromEnv } from "../pr/revisor-client.js";
import { createRevisorLocalPrClient } from "../pr/revisor-local-pr-client.js";
import { submitSessionLocalPr } from "../pr/local-pr-submission.js";
import { submitDirectLocalPr } from "../pr/direct-submission.js";
import { SessionPrOperations } from "../pr/session-pr-operations.js";
import { listBranchCommits } from "../pr/branch-commits.js";
import { loadSessionTaskPrContent } from "../pr/session-task-pr-content.js";
import { createRevisorTestWorkflowClient } from "../pr/revisor-test-workflow-client.js";
import { makeRevisorConfigRepo } from "../db/revisor-config-repo.js";
import { resolveRevisorWorkflowToken } from "../pr/revisor-config.js";
import { ConfirmRunsRepo } from "../db/confirm-runs-repo.js";
import { ExcubitorClient } from "../excubitor/client.js";
import { CatalogGeniusClient } from "../inquiry/genius-client.js";
import { DirectorRepo } from "../director/repo.js";
import { DirectorService } from "../director/service.js";
import { GeniusModelReviewService } from "../model-review/service.js";
import { applyRuntimeModelReview } from "../model-review/runtime-switch.js";
import { MemoriaClient } from "../memoria/client.js";
import { TaskMdStore } from "../taskflow/md-store.js";
import { TaskflowStateStore } from "../taskflow/state-store.js";
import { MemoriaBackend } from "../taskflow/backend.js";
import { startTaskReconciler } from "../taskflow/reconcile.js";
import { TaskflowRuntime } from "../taskflow/runtime.js";
import { notifyUserDecision } from "../taskflow/notify.js";
import { ConfirmService } from "../release/confirm-service.js";
import { ServiceMap } from "../release/service-map.js";
import { intakeDevelopMerge } from "../release/confirm-intake.js";
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
import { runBootPhases } from "./boot-phases.js";
import { ResourceOwner } from "./resource-owner.js";
import { makeChatReadModel } from "../api/chat-read-models.js";
import { makeSlackConfigRepo } from "../db/slack-config-repo.js";
import { makeSlackSessionChannelsRepo } from "../slack/session-channels-repo.js";
import { resolveSlackConfig } from "../slack/config.js";
import { resolveDiscordConfig } from "../discord/conn-config.js";
import { resolveSessionSourceLinks } from "../pr/session-source-links.js";
import { syncSessionForumTemplateTags } from "../discord/forum-template-tags.js";
import { loadSecretBox } from "../shared/secret-box.js";
import { StaffRepo } from "../db/staff-repo.js";
import { capabilityAllowed } from "../staff/roles.js";
import { authorizeStaffCapability } from "../staff/capability-authorization.js";
import { createFederationRuntime } from "../federation/runtime.js";
import { getReactionWorkflowReadiness } from "../shared/reaction-workflow-readiness.js";
import { configureLoopHaltNotifier } from "../shared/loop-bulkhead.js";
import { ImplementationToolsService } from "../implementation-tools/service.js";
import type { BotRuntimeStatus } from "../api/platform-runtime-status.js";
import type { ChatPlatform } from "../platform/chat-platform.js";
import {
  CHAT_WORKER_CHECK_MS,
  chatEmbeddedEnabled,
  readChatMode,
  readChatWorkerLease,
} from "./chat.js";
import {
  recordDiscordBotStop,
  type DiscordRestartPolicyState,
} from "./discord-restart-policy.js";
import {
  COST_WORKER_CHECK_MS,
  costEmbeddedEnabled,
  createCostLeaseWatchTick,
  createCostRuntime,
  readCostMode,
  readCostWorkerLease,
} from "./cost.js";
import {
  WORKFLOW_WORKER_CHECK_MS,
  readWorkflowMode,
  readWorkflowWorkerLease,
  workflowEmbeddedEnabled,
} from "./workflow.js";
import { WorkflowBindingRegistry } from "../workflow/binding-registry.js";
import type { WorkflowKey } from "../workflow/keys.js";
import { startEventLoopMonitor } from "../shared/event-loop-monitor.js";
import { recordEventLoopStall } from "../instrumentation.js";

const log = createChildLogger("server");

let discordBotHandle: DiscordBotHandle | null = null;
let hasLiveChatWorkerLease: () => boolean = () => false;
let discordBotDeps: DiscordBotDeps | null = null;
/**
 * 本社内 desk (mode='desk' の窓口) を本社 Bot 起動のたびに DB から解決する。 desk は
 * API から後付けで作られるので、 起動時に固定せず start ごとに引き直す (= Bot を
 * restart すれば新しい desk が受付を始める)。
 */
let resolveHeadOfficeDesk: () => DiscordBotDeps["desk"] = () => undefined;
let slackBotHandle: ChatPlatform | null = null;
let slackBotDeps: SlackBotDeps | null = null;
let discordBotLastStatus: string | null = "not_started";
let discordBotLastError: string | null = null;
let slackBotLastStatus: string | null = "not_started";
let slackBotLastError: string | null = null;
let discordBotRestartTimer: ReturnType<typeof setTimeout> | null = null;
const discordBotRestartPolicy: DiscordRestartPolicyState = { stops: [] };

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

function clearDiscordBotAutoRestart(): void {
  if (!discordBotRestartTimer) return;
  clearTimeout(discordBotRestartTimer);
  discordBotRestartTimer = null;
}

function scheduleDiscordBotAutoRestart(status: string, error?: string): void {
  if (!discordEmbeddedEnabled()) return;
  if (status === "stopped" || status === "disabled") return;
  if (discordBotRestartTimer) return;

  const windowMs = readPositiveIntEnv("CONCORDIA_DISCORD_AUTO_RESTART_WINDOW_MS", 10 * 60 * 1000);
  const limit = readPositiveIntEnv("CONCORDIA_DISCORD_AUTO_RESTART_LIMIT", 5);
  const decision = recordDiscordBotStop(discordBotRestartPolicy, {
    nowMs: Date.now(),
    windowMs,
    limit,
  });
  const detail = error ? `${status}: ${error}` : status;
  if (!decision.shouldRestart) {
    const message =
      `Discord bot auto restart suppressed after ${decision.recentStops} stops ` +
      `within ${Math.round(windowMs / 1000)}s; last=${detail}`;
    log.error(message);
    rememberDiscordBotResult({ ok: false, status: "error", error: message });
    return;
  }

  const delayMs = readPositiveIntEnv("CONCORDIA_DISCORD_AUTO_RESTART_DELAY_MS", 5_000);
  log.warn(
    `Discord bot stopped (${detail}); auto restart scheduled in ${delayMs}ms ` +
    `(${decision.recentStops}/${limit} stops in window)`,
  );
  discordBotRestartTimer = setTimeout(() => {
    discordBotRestartTimer = null;
    void startDiscordBotManaged()
      .then((result) => {
        if (!result.ok) scheduleDiscordBotAutoRestart("restart_failed", result.error);
      })
      .catch((e) => scheduleDiscordBotAutoRestart("restart_exception", (e as Error).message));
  }, delayMs);
  discordBotRestartTimer.unref?.();
}

async function startSlackBotManaged(): Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }> {
  if (!chatEmbeddedEnabled()) return rememberSlackBotResult({ ok: true, status: "disabled" });
  if (hasLiveChatWorkerLease()) return rememberSlackBotResult({ ok: true, status: "disabled" });
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
  clearDiscordBotAutoRestart();
  if (!discordEmbeddedEnabled()) return rememberDiscordBotResult({ ok: true, status: "disabled" });
  if (hasLiveChatWorkerLease()) return rememberDiscordBotResult({ ok: true, status: "disabled" });
  if (discordBotHandle) return rememberDiscordBotResult({ ok: true, status: "already_running" });
  if (!discordBotDeps) return rememberDiscordBotResult({ ok: false, status: "error", error: "discord deps not initialized" });
  try {
    rememberDiscordBotResult({ ok: true, status: "starting" });
    const h = await startDiscordBot({ ...discordBotDeps, desk: resolveHeadOfficeDesk() });
    if (!h) return rememberDiscordBotResult({ ok: true, status: "disabled" });
    discordBotHandle = h;
    return rememberDiscordBotResult({ ok: true, status: "started" });
  } catch (e) {
    return rememberDiscordBotResult({ ok: false, status: "error", error: (e as Error).message });
  }
}

async function stopDiscordBotManaged(): Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }> {
  clearDiscordBotAutoRestart();
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
  configureLoopHaltNotifier((state) => {
    eventBus.emit({
      type: "error.reported",
      source: "loop-bulkhead",
      message: `Background loop halted: ${state.name}`,
      detail: { ...state },
      ts: Math.floor(Date.now() / 1000),
    });
  });

  // HTTP API は Web gateway / platform adapter の内側で使う内部面。サービス token を
  // 廃止したため、直接 LAN へ bind して AccessControl を迂回できる構成は許可しない。
  if (!isLoopbackHost(cfg.host)) {
    throw new Error(
      `CONCORDIA_HOST=${cfg.host} is non-loopback. ` +
        "Concordia mutation APIs are internal-only; bind to 127.0.0.1 and expose the Web UI through AccessControl.",
    );
  }

  const dbPath = cfg.dbPath;

  const db = openDb(dbPath);
  const repo = new SessionsRepo(db);
  const controlJobs = new ControlJobsRepo(db);
  // プロセス再起動時は in-memory の WS 接続が全部消えているので、
  // sessions.ws_clients を 0 にリセットして整合性を保つ.
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const skills = new SkillsRepo(db);
  const rules = new RulesRepo(db);
  const dayReports = new DayReportsRepo(db);
  const processes = new ProcessesRepo(db);
  const stats = new StatsRepo(db);
  const prs = new PrRecordsRepo(db);
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  const transcriptLogs = new TranscriptLogsRepo(db);
  const sessionMessages = new SessionMessagesRepo(db);
  const sessionMessageReads = new SessionMessageReadsRepo(db);
  const webPush = new WebPushRepo(db);
  const webPushService = new WebPushService(webPush);
  const stopWebPushService = webPushService.start();
  const messageService = new SessionMessageService({ repo: sessionMessages });
  const stopMessageService = messageService.start();
  const pendingQuestions = makeDiscordPendingQuestionsRepo(db);
  // Discord channel/config repos は bot 起動とは独立に (bot OFF でも) Lictor の
  // discord-channels lookup / egress 明示 routing で使うので app 層にも渡す.
  const discordChannels = makeDiscordSessionChannelsRepo(db);
  const discordConfig = makeDiscordConfigRepo(db);
  hasLiveChatWorkerLease = () => readChatWorkerLease(discordConfig) !== null;
  const workflowMode = readWorkflowMode();
  const hasLiveWorkflowWorkerLease = () => readWorkflowWorkerLease(discordConfig) !== null;
  // Slack 連携をサービス内 (DB) で設定するための repo + token 暗号化用 secret-box。
  // 鍵は DB の外 (env CONCORDIA_SECRET_KEY、 無ければ cwd の concordia.secret.key) に置く。
  const slackConfig = makeSlackConfigRepo(db);
  const slackChannels = makeSlackSessionChannelsRepo(db);
  const secretBox = loadSecretBox({
    envValue: process.env.CONCORDIA_SECRET_KEY,
    keyFile: join(process.cwd(), "concordia.secret.key"),
  });
  // マルチ拠点連合 (spec/plan/multi-site-federation.md) Phase 1。
  // listener / 拠点クライアントの起動は opt-in (env、startRoles で後述)。管理 API は
  // 常時マウントし、listener 有効化前に拠点登録 (トークン発行) できるようにする。
  // env の設定不備 (LISTEN=1 かつ PORT 未指定) はここで throw = 起動前に落とす。
  const federation = createFederationRuntime({
    db,
    secretBox,
    version: process.env.npm_package_version ?? "dev",
  });
  const participants = makeParticipantsRepo(db);
  const delegationRepo = new DelegationRepo(db);
  const modelCatalog = new ModelCatalogRepo(db);
  const subsidiaryRepo = new SubsidiaryRepo(db);
  const harnessRepo = new HarnessRulesRepo(db);
  // 社員名簿 = spawn / end-session / キルスイッチの権限判定の正本 (旧 allowlist の置き換え)。
  const staffRepo = new StaffRepo(db);
  const harnessAuditRepo = new HarnessAuditRepo(db);
  const harnessBlackbox = createHarnessBlackbox(db);
  const injectManualsRepo = new InjectManualsRepo(db);
  // 子会社の日次トークン予算トラッカー。 subsidiary_id タグ付きセッションの当日消費を
  // ログから直接合算する (グローバル予算と違い delta 累積は不要 = 冪等)。
  const subsidiaryBudget = new SubsidiaryBudgetTracker({ sessionsRepo: repo });
  const publicUrlForDelegation = `http://${cfg.host}:${cfg.port}`;
  const delegationService = new DelegationService({
    repo: delegationRepo,
    concordiaUrl: publicUrlForDelegation,
    effortBlackbox: new DelegationEffortBlackbox(db, runClaude),
    // kind 別 Inject マニュアル (WebUI /manuals で調整) を協調コンテキストへ差し込む。
    injectManual: (kind) => injectManualsRepo.get(kind)?.content ?? null,
  });
  const workspaceRootDefault = cfg.workspaceRoot || cfg.spawnDefaultCwd;
  const adminState = new AdminState(db, {
    workspaceRoot: workspaceRootDefault,
    workspaceRoots: cfg.workspaceRoots.length ? cfg.workspaceRoots : (workspaceRootDefault ? [workspaceRootDefault] : []),
    githubOrg: cfg.githubOrg,
    reactionWorkflowEnabled: process.env.CONCORDIA_REACTION_WORKFLOW === "1",
    ccWorkflowEnabled: readCcWorkflowEnabled(),
    // dev モードの Lictor リポ既定 (= <workspaceRoot>/Lictor)。 空でも GUI で設定可。
    lictorDevPath: workspaceRootDefault ? join(workspaceRootDefault, "Lictor") : "",
    reaperSessionEndGraceSec: cfg.reaperSessionEndGraceSec,
  }, secretBox);
  // ワークフロー個別有効化 (W1)。 無効なワークフローの購読 / スケジューラ / Discord
  // コマンド登録は行わない。 フラグは都度解決で、 値の変化はレジストリが検知して
  // 登録側を張り替える。 spec/feature/workflow-toggles-and-permission-noise.md
  const isWorkflowEnabled = (key: WorkflowKey): boolean => adminState.isWorkflowEnabled(key);
  const workflowBindings = new WorkflowBindingRegistry({
    isEnabled: isWorkflowEnabled,
    log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
  });

  const reactionWorkflowReadiness = getReactionWorkflowReadiness({
    enabled: adminState.getReactionWorkflowEnabled(),
    discordAuthorizedCount: staffRepo.countByCapability("discord", "session_spawn"),
    slackAuthorizedCount: staffRepo.countByCapability("slack", "session_spawn"),
  });
  if (reactionWorkflowReadiness.issues.length > 0) {
    log.warn(
      {
        readiness: reactionWorkflowReadiness.status,
        issues: reactionWorkflowReadiness.issues,
        discord_user_count: reactionWorkflowReadiness.platforms.discord.authorized_user_count,
        slack_user_count: reactionWorkflowReadiness.platforms.slack.authorized_user_count,
      },
      "reaction-workflow is enabled with an empty platform allowlist",
    );
  }
  // delegation 実行キュー: 同時実行上限を超えた invoke は spawn せず queued で待たせ、
  // スロットが空き次第 FIFO で起動する。 service ⇄ queue は相互依存なので setQueue で繋ぐ。
  const delegationQueue = new DelegationQueue({
    repo: delegationRepo,
    sessions: repo,
    resolveMaxConcurrency: () => adminState.getDelegationMaxConcurrency(),
    spawnQueued: (run) => delegationService.spawnQueuedRun(run),
    producerOnly: () => workflowMode === "worker" || hasLiveWorkflowWorkerLease(),
  });
  delegationService.setQueue(delegationQueue);

  // 確認フロー (develop に入った変更をユーザが動作確認 → main へ反映)。
  // 起動・停止は必ず Excubitor 経由 (catalog 登録済みサービスのみ)。
  // spec/feature/develop-confirm-flow.md。
  const confirmRuns = new ConfirmRunsRepo(db);
  const excubitorClient = new ExcubitorClient();
  const director = new DirectorService({
    repo: new DirectorRepo(db),
    genius: new CatalogGeniusClient(excubitorClient),
    scoreMin: cfg.inquiryScoreMin,
  });
  const modelReview = new GeniusModelReviewService({
    genius: new CatalogGeniusClient(excubitorClient),
    models: modelCatalog,
    judge: runClaude,
    scoreMin: cfg.inquiryScoreMin,
  });
  // Revisor workflow token は DB (revisor_config、 secret-box 暗号化) が正本で、 env は
  // フォールバック。 クライアントはリクエストごとに解決するので Web UI の変更が即効く。
  // Revisor は変更系 (merge 含む) を workflow token 1 本で認可するため、 merge 用の
  // RevisorClient にも同じ resolver を渡す (旧 CONCORDIA_REVISOR_TOKEN の廃止方向)。
  const revisorConfigRepo = makeRevisorConfigRepo(db);
  const resolveRevisorToken = () => resolveRevisorWorkflowToken(revisorConfigRepo, secretBox);
  const revisorClient = createRevisorClientFromEnv(excubitorClient, process.env, resolveRevisorToken);
  const revisorTestWorkflow = createRevisorTestWorkflowClient(excubitorClient, resolveRevisorToken);
  const memoriaClient = new MemoriaClient();
  const taskStore = new TaskMdStore(() => adminState.getWorkspaceRoots(), undefined, new TaskflowStateStore(db));
  const serviceMap = new ServiceMap({ excubitor: excubitorClient });
  const resolveServiceCode = (repoName: string) => serviceMap.resolve(repoName);
  const confirmService = new ConfirmService({
    repo: confirmRuns,
    excubitor: excubitorClient,
    memoria: memoriaClient,
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
  });
  const taskflowRuntime = new TaskflowRuntime({
    db,
    sessions: repo,
    delegation: delegationRepo,
    prs,
    store: taskStore,
    confirm: { repo: confirmRuns, memoria: memoriaClient, resolveServiceCode },
    // Revisor 運用 (GitHub PR を作らない) でもゴール判断が空転しないよう local PR を見る。
    revisor: revisorClient,
    mentionUserId: () => adminState.getMentionUserId(),
    // 未回答の質問は blocker: 回答が来るまで taskflow の自動 inject を出さない。
    hasPendingQuestion: pendingQuestionProbe(pendingQuestions),
  });

  // spawn の Lictor launcher を AdminState 設定から live 解決する (dev/prod/auto)。
  setLictorLauncherResolver(() => resolveLictorLauncher(adminState));
  // spawn する Lictor が必ず spawning Concordia を指すよう、 自分の listen アドレスを
  // env 継承ではなく CONCORDIA_HOST / CONCORDIA_PORT として明示注入する。
  setConcordiaAddress(() => ({ host: cfg.host, port: cfg.port }));
  setWorkspaceRootsResolver(() => adminState.getWorkspaceRoots());

  // テスト交通整備: 起動テスト/再起動の宣言レジストリ (/v1/testing) + ブランチ切替
  // 監視 inject。 spec/feature/testing-traffic.md
  const testingClaims = new TestingClaimsRepo(db);
  // セッション終了/喪失で claim を自動解放 (放置クレームの残留防止)。
  // workflow.test が無効な間は購読自体を張らない。
  workflowBindings.register({
    key: "test",
    name: "testing-claim-release",
    start: () => {
      const unsubscribe = eventBus.subscribe((ev) => {
        if (ev.type === "session.ended" || ev.type === "session.lost") {
          try {
            releaseTestingClaims(testingClaims, {
              sessionId: ev.session_id,
              now: Math.floor(Date.now() / 1000),
            });
          } catch { /* best-effort */ }
        }
      });
      return { stop: unsubscribe };
    },
  });

  // レビュー発火: セッションが終わったら、 その作業ブランチを Revisor の local PR として
  // 自動提出する。 旧経路 (GitHub PR の CI success → /v1/pr-gate/jobs) は Revisor が
  // local PR ワークフローへ移行したときにエンドポイントごと無くなり、 以来「人が手で
  // 提出したときだけレビューされる」状態だった。 失敗してもセッション終了処理は止めない。
  const revisorLocalPrs = createRevisorLocalPrClient(excubitorClient, resolveRevisorToken);
  const localPrLog = createChildLogger("revisor-local-pr");
  const localPrDeps = {
    revisor: revisorLocalPrs,
    listBranchCommits,
    loadSessionTaskPrContent: (repoPath: string, sessionId: string) =>
      loadSessionTaskPrContent(repoPath, sessionId),
    resolveSourceLinks: (sessionId: string) => resolveSessionSourceLinks({
      discordChannels,
      slackChannels,
      resolveDiscordGuildId: () => resolveDiscordConfig(discordConfig, secretBox).guildId,
      resolveSlackBotToken: () => resolveSlackConfig(slackConfig, secretBox).botToken,
      log: localPrLog,
    }, sessionId),
    log: localPrLog,
  };
  // direct 提出 (session 非依存)。 repo_path の境界は implementation-tools と同じ
  // workspace roots を使う。
  const submitDirectLocalPrRequest = (request: {
    repoPath: string;
    branch?: string;
    sessionId?: string;
    prContent?: string;
    fastLane?: boolean;
  }) =>
    submitDirectLocalPr(
      { ...localPrDeps, resolveWorkspaceRoots: () => adminState.getWorkspaceRoots() },
      request,
    );
  const submitLocalPrForSession = async (
    sessionId: string,
    options: { fastLane?: boolean } = {},
  ) => {
    const session = repo.findSession(sessionId);
    if (!session) return { submitted: false as const, reason: "session_not_found" as const };
    return submitSessionLocalPr(
      localPrDeps,
      {
        sessionId: session.id,
        repoPath: session.repo_path,
        repository: session.repo_origin,
        branch: session.branch,
        fastLane: options.fastLane === true,
      },
    );
  };
  // PR 提出 / マージ (RWF 📮 🔀 と Discord 操作パネル) の実体。 提出は上の
  // submitLocalPrForSession をそのまま使い、 マージは指示者 (押した人) の役職を
  // 名簿で確認してから Revisor へ流す。 監査は構造化ログ + session event。
  const makeSessionPrOperations = (platform: "discord" | "slack") => new SessionPrOperations({
    platform,
    sessions: repo,
    submit: submitLocalPrForSession,
    listLocalPullRequests: () => revisorLocalPrs.listLocalPullRequests(),
    merge: {
      staff: staffRepo,
      merger: revisorClient,
      audit: (record) => {
        localPrLog.info(record, "local PR merged with reaction/panel requester authorization");
        repo.appendEvent({
          session_id: record.session_id,
          ts: Math.floor(Date.now() / 1000),
          kind: "pr-merged",
          payload: record,
        });
      },
      logError: (message) => localPrLog.warn({ err: message }, "local PR merge failed"),
    },
    source: `${platform}-reaction-workflow`,
  });
  const discordPrOperations = makeSessionPrOperations("discord");
  const slackPrOperations = makeSessionPrOperations("slack");
  const implementationTools = new ImplementationToolsService({
    sessions: repo,
    claims: testingClaims,
    excubitor: excubitorClient,
    submitLocalPr: submitLocalPrForSession,
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
    log: { warn: (message) => localPrLog.warn({}, message) },
  });
  // レビュー発火の購読。 workflow.review が無効な間は購読自体を張らない
  // (安全弁 revisor_auto_submit とは別軸: あちらは「発火するか」、 こちらは「そもそも
  // レビューワークフローを動かすか」)。
  workflowBindings.register({
    key: "review",
    name: "revisor-local-pr-auto-submit",
    start: () => {
      const unsubscribe = eventBus.subscribe((ev) => {
        if (ev.type !== "session.ended") return;
        if (!adminState.getRevisorAutoSubmitEnabled()) return;
        const session = repo.findSession(ev.session_id);
        if (!session) return;
        void submitLocalPrForSession(session.id, { fastLane: false });
      });
      return { stop: unsubscribe };
    },
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

  // コストサンプリングは workflow.cost に属する。 無効な間は起動しない。
  workflowBindings.register({
    key: "cost",
    name: "cost-sampler",
    start: () => {
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
      return { stop: () => costRuntime.stop() };
    },
  });

  const processManager = new ProcessManager({
    repo: processes,
    logsDir: join(process.cwd(), "logs"),
  });

  const sweeper = startSweeper({
    repo,
    tasks,
    transcriptLogs,
    sessionMessages,
    rules,
    stats,
    intervalMs: cfg.sweeperIntervalMs,
    lostAfterSec: cfg.lostAfterSec,
    abandonedAfterSec: cfg.abandonedAfterSec,
    lostPurgeAfterSec: cfg.lostPurgeAfterSec,
    purgeAfterDays: cfg.purgeAfterDays,
    transcriptRetentionDays: readPositiveIntEnv(
      "CONCORDIA_TRANSCRIPT_LOG_RETENTION_DAYS",
      cfg.purgeAfterDays,
    ),
    rulesLogRetentionDays: readPositiveIntEnv(
      "CONCORDIA_RULES_LOG_RETENTION_DAYS",
      cfg.purgeAfterDays,
    ),
    sessionStatsRetentionDays: readPositiveIntEnv(
      "CONCORDIA_SESSION_STATS_RETENTION_DAYS",
      cfg.purgeAfterDays,
    ),
  });

  // 孤児プロセス回収: 終了/消滅した session に紐付かない Lictor / agent-client を周期 kill。
  // sweeper が行を purge して記録が消えた分も OS 走査で回収する (止血は kill 経路の配線、 これは掃除)。
  // PC パフォーマンス監視: ホストのメモリ/CPU + 上位プロセス + セッション別 RSS を
  // 周期サンプリングして host_metrics に蓄積。 Monitor ページが最新スナップショットを表示する。
  const metricsStore = new MetricsStore(db);
  const toolPath = join(process.cwd(), "tools", "concordia-hook.mjs");
  const publicUrl = `http://${cfg.host}:${cfg.port}`;

  // 日次レビュー scheduler は workflow.daily に属する。 API (/v1/daily-reports) には
  // 実体ではなくこの port を渡し、 無効な間は実体を持たない (API 側は 409 で止まる)。
  let dailyScheduler: ReturnType<typeof startDailyScheduler> | null = null;
  const dailySchedulerPort = {
    stop: () => dailyScheduler?.stop(),
    runOnce: async (dateIso?: string) => {
      if (!dailyScheduler) {
        throw new Error("daily workflow is disabled (admin.workflow.daily.enabled)");
      }
      await dailyScheduler.runOnce(dateIso);
    },
  };
  workflowBindings.register({
    key: "daily",
    name: "daily-report-scheduler",
    start: () => {
      dailyScheduler = startDailyScheduler({ sessions: repo, dayReports });
      return {
        stop: () => {
          dailyScheduler?.stop();
          dailyScheduler = null;
        },
      };
    },
  });
  // 起動時点で有効なものを立ち上げる (post-listen の binding は後段でもう一度 sync する)。
  workflowBindings.sync();

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
    sessionTaskRecordsRepo: sessionTaskRecords,
    tasksRepo: tasks,
    prRecordsRepo: prs,
    usageFrames: transcriptLogs,
    hasPendingQuestion: (sessionId) => pendingQuestions.findLatestUnanswered(sessionId) !== null,
    delegationRepo,
    perfLog: createChildLogger("cost-report"),
    // worker モードは cost-worker が別途 host_metrics/DB へサンプリング済みなので、
    // embedded 側の cost snapshot はログ JSONL のフルスキャンをせず軽量表示に倒す。
    costSnapshotAllowFullScan: costMode !== "worker",
  });

  // observability (サービス監視 / catalog / auto-fix) は Excubitor (port 17332) に
  // 分離した (2026-05-31)。Concordia は AI 協調支援に専念。Vestigium ログ閲覧の
  // MCP だけ Concordia 同梱のまま (src/mcp/vestigium-*)。

  discordBotDeps = {
    db,
    readModel: chatReadModel,
    chatRepo: chat,
    sessionsRepo: repo,
    revisorTestWorkflow,
    revisor: revisorClient,
    // channel 作成前に届いた transcript frame の埋め戻し (transcript-replay)。
    transcriptLogs,
    // 本社モニターの「本社/子会社別コスト」用。 子会社 Bot は manager が baseDiscordDeps を
    // そのまま使うが、 monitor 側で subsidiary モード時は無視するので渡しても害は無い。
    listSubsidiaries: () =>
      subsidiaryRepo.list().map((s) => ({ id: s.id, name: s.display_name || s.name, daily_token_budget: s.daily_token_budget })),
    concordiaUrl: publicUrl,
    routeFederationIngress: (input) => federation.routeIngress({
      guild_id: input.guildId,
      channel_id: input.channelId,
      message_id: input.messageId,
      author_id: input.authorId,
      author_label: input.authorLabel,
      text: input.text,
      ts: input.ts,
      applied_tag_names: input.appliedTagNames,
    }),
    resolveForumSiteTags: () => federation.listForumSiteTagNames(),
    setFederationEgressExecutor: federation.setEgressExecutor,
    // AskUserQuestion 回答は in-process 直呼び (self-fetch は backlog 溢れ時に
    // 「fetch failed」でユーザに何も返らない事故になるため使わない)。
    answerQuestion: (sessionId, body) =>
      answerPendingQuestion(
        { sessions: repo, questions: questionStoreFromRepo(pendingQuestions) },
        sessionId,
        body,
      ),
    // リアクションワークフロー: ローカルクローン親 (Memoria 解決用) + 安全弁。
    // workspaceRoot は設定 GUI (AdminState) で上書き可能。 bot start のたびに live 値を読む。
    workspaceRoot: cfg.workspaceRoot || cfg.spawnDefaultCwd,
    resolveWorkspaceRoot: () => adminState.getWorkspaceRoot(),
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
    resolveSessionSpawnCwd: (provider, requested) =>
      resolveAgentHomeCwd(provider, requested, adminState.getWorkspaceRoot()),
    // 安全弁は AdminState (schema_meta) を毎回 live 評価 → 設定 GUI トグルが再起動なしで反映。
    resolveReactionWorkflowEnabled: () => adminState.getReactionWorkflowEnabled(),
    // ユーザ設定の 絵文字→アクション 上書き (設定 GUI) を live 反映。
    resolveReactionMappings: () => adminState.getReactionEmojiOverrides() as Record<string, WorkflowAction>,
    // 権限は社員名簿 (staff_members) の役職で決める。 判定は毎回 live 参照 = WebUI で
    // 役職を変えたら再起動なしで効く。 未登録は ヒラ社員 相当 (会話 + リアクション発火)。
    isReactionWorkflowUserAllowed: (userId) =>
      capabilityAllowed(staffRepo.roleOf("discord", userId), "reaction_workflow"),
    // 発火は誰でもできる。 指示の中身が要求する権限だけをここで判定する。
    hasStaffCapability: (userId, capability) =>
      authorizeStaffCapability(staffRepo, "discord", userId, capability).allowed,
    isLaunchUserAllowed: (userId) =>
      capabilityAllowed(staffRepo.roleOf("discord", userId), "session_spawn"),
    isSessionEndUserAllowed: (userId) =>
      capabilityAllowed(staffRepo.roleOf("discord", userId), "session_end"),
    isKillSwitchUserAllowed: (userId) =>
      capabilityAllowed(staffRepo.roleOf("discord", userId), "kill_switch"),
    // LLM に触れた Discord ユーザを名簿へ記録する (サーバーでのプロファイル名も取る)。
    recordStaffAccess: (input) => {
      staffRepo.touch({
        platform: "discord",
        platformUserId: input.userId,
        displayName: input.displayName,
        profileName: input.profileName,
      });
    },
    // 📮 PR 提出 / 🔀 マージ (リアクションと操作パネルの共通実体)。
    prOperations: discordPrOperations,
    runHeadless: runClaude,
    repinSession: (sessionId) => repinSession(repo, sessionId),
    modelReview,
    applyRuntimeModelReview: (input) => applyRuntimeModelReview(repo, input),
    onRuntimeState: (state) => {
      discordBotLastStatus = state.status;
      discordBotLastError = state.error ?? null;
      if (state.running) {
        if (state.status === "ready") clearDiscordBotAutoRestart();
        return;
      }
      discordBotHandle = null;
      scheduleDiscordBotAutoRestart(state.status, state.error);
    },
    // start のたびに DB+env から実効設定を解決 → 設定変更後の restart で即反映。
    resolveConfig: () => resolveDiscordConfig(discordConfig, secretBox),
    // ワークフロー有効化フラグ (W1)。 無効なワークフローの slash command は登録せず、
    // リアクション購読も張らない。 値は都度解決なので稼働中の変更も張り替わる。
    resolveWorkflowEnabled: isWorkflowEnabled,
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
    // 安全弁 (設定 GUI) と workflow.reaction の AND を毎回 live 評価する。
    resolveReactionWorkflowEnabled: () =>
      isWorkflowEnabled("reaction") && adminState.getReactionWorkflowEnabled(),
    // ユーザ設定の 絵文字→アクション 上書き (設定 GUI) を live 反映。
    resolveReactionMappings: () => adminState.getReactionEmojiOverrides() as Record<string, WorkflowAction>,
    // Discord と同じく社員名簿の役職で判定する (platform=slack の行を引く)。
    isReactionWorkflowUserAllowed: (userId) =>
      capabilityAllowed(staffRepo.roleOf("slack", userId), "reaction_workflow"),
    // 発火は誰でもできる。 指示の中身が要求する権限だけをここで判定する。
    hasStaffCapability: (userId, capability) =>
      capabilityAllowed(staffRepo.roleOf("slack", userId), capability),
    isLaunchUserAllowed: (userId) =>
      capabilityAllowed(staffRepo.roleOf("slack", userId), "session_spawn"),
    isSessionEndUserAllowed: (userId) =>
      capabilityAllowed(staffRepo.roleOf("slack", userId), "session_end"),
    recordStaffAccess: (input) => {
      staffRepo.touch({
        platform: "slack",
        platformUserId: input.userId,
        displayName: input.displayName,
        profileName: input.profileName,
      });
    },
    // 📮 PR 提出 / 🔀 マージ。 役職は Slack の名簿で引く (platform 束縛が違うだけ)。
    prOperations: slackPrOperations,
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

  // 本社内 desk (軽量窓口): 専用 Bot を立てず、 本社 Bot に「タスク依頼」チャンネルを
  // 1 本作らせて同じガードゲートに通す。 有効な desk は先頭 1 件のみ配線する — 本社 guild に
  // 依頼チャンネルを何本も生やすと、 どこに投げれば動くのかが人間側で分からなくなるため。
  resolveHeadOfficeDesk = () => {
    const desks = subsidiaryRepo.listEnabledDesks();
    const desk = desks[0];
    if (!desk) return undefined;
    if (desks.length > 1) {
      log.warn(
        { desk: desk.name, ignored: desks.slice(1).map((d) => d.name) },
        "複数の desk が有効です。 本社 Bot は先頭の 1 件だけを受付に配線します",
      );
    }
    const processor = subsidiaryManager.processorFor(desk.id);
    return {
      id: desk.id,
      channelName: desk.display_name?.trim() || DEFAULT_DESK_CHANNEL_NAME,
      channelId: desk.channel_id,
      process: processor.process,
      isLocked: processor.isLocked,
      onChannelResolved: (channelId: string) => subsidiaryRepo.update(desk.id, { channel_id: channelId }),
    };
  };

  const app = buildApp({
    repo,
    controlJobs,
    metrics: metricsStore,
    tasks,
    chat,
    skills,
    rules,
    dayReports,
    processes,
    stats,
    prs,
    sessionTaskRecords,
    transcriptLogs,
    sessionMessages,
    sessionMessageReads,
    projectSessionEvent: (event) => messageService.project(event),
    webPush,
    webPushService,
    pendingQuestions,
    discordChannels,
    costSamples: usageSamplesRepo,
    costLimitSamples: costLimitSamplesRepo,
    costOneShots: costOneShotsRepo,
    discordConfig,
    participants,
    delegation: delegationRepo,
    delegationService,
    confirmService,
    delegationQueue,
    modelCatalog,
    testingClaims,
    subsidiary: subsidiaryRepo,
    harnessRules: harnessRepo,
    staff: staffRepo,
    // PRs ページの Revisor セクション (local PR 一覧 + Revisor UI へのリンク)。
    revisorLocalPrs: revisorClient ?? undefined,
    revisorLocalPrMerger: revisorClient,
    revisorLocalPrCloser: revisorClient,
    revisorLocalPrPromoter: revisorClient,
    revisorConfig: revisorConfigRepo,
    implementationTools,
    // レビュー発火の手動口 (POST /v1/prs/local)。 自動提出と同じ経路を通す。
    submitLocalPr: submitLocalPrForSession,
    // session 非依存の direct 提出口 (POST /v1/prs/local/direct)。
    submitDirectLocalPr: submitDirectLocalPrRequest,
    injectManuals: injectManualsRepo,
    harnessAudit: harnessAuditRepo,
    harnessRunClaude: runClaude,
    harnessBlackbox,
    subsidiaryManager,
    subsidiaryBudget,
    adminState,
    costStatus: () => costRuntime.tracker.status(),
    costOverviewSource: costMode === "worker" ? "samples" : "live",
    processManager,
    dailyScheduler: dailySchedulerPort,
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
    federation: federation.apiDeps,
    director,
    taskStore,
    onTaskflowCompleted: (run) => taskflowRuntime.handleCompletedRun(run),
    syncDiscordForumTags: async (templates) => {
      const config = resolveDiscordConfig(discordConfig, secretBox);
      return syncSessionForumTemplateTags({
        token: config.token ?? "",
        forumId: discordConfig.get("session_forum_id") ?? "",
        templates,
        siteTags: await federation.listForumSiteTagNames(),
      });
    },
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
    registerPostListenWorkflowBindings();
    trackPostListenHandle(
      startReaper(
        { repo, controlJobs },
        {
          enabled: cfg.reaperEnabled,
          intervalMs: cfg.reaperIntervalMs,
          minAgeSec: cfg.reaperMinAgeSec,
          lostGraceSec: cfg.reaperLostGraceSec,
          sessionEndGraceSec: () => adminState.getReaperSessionEndGraceSec(),
        },
      ),
    );
    trackPostListenHandle(
      startMetricsLoop(
        {
          repo,
          store: metricsStore,
          excubitorClient,
          notifyLag: (snapshot) => {
            eventBus.emit({
              type: "error.reported",
              source: "event-loop-lag",
              message: `Event-loop lag p99 ${snapshot.p99}ms exceeded threshold`,
              detail: { ...snapshot },
              ts: Math.floor(Date.now() / 1000),
            });
          },
        },
        {
          enabled: cfg.metricsEnabled,
          intervalMs: cfg.metricsIntervalMs,
          retentionHours: cfg.metricsRetentionHours,
        },
      ),
    );
    // 「セッション終了」の発言をターン終了後に /end-session 相当まで持っていく。
    // セッション自身が session-end を回しきれなくてもプロセスを残さないための保険なので、
    // ワークフロートグルではなくセッション制御基盤として常時動かす。
    trackPostListenHandle(
      startEndSessionRequestWatch({
        sessions: repo,
        endSession: (session, reason) => endSessionNow(
          {
            repo,
            chat,
            config: cfg,
            harnessAudit: harnessAuditRepo,
            transcriptLogs,
            questionState: pendingQuestions,
          },
          session,
          reason,
        ),
      }),
    );
    trackPostListenHandle(
      startStalledSessionNudge({
        repo,
        enabled: cfg.stallNudgeEnabled,
        intervalMs: cfg.stallNudgeIntervalMs,
        idleSec: cfg.stallIdleSec,
        cooldownSec: cfg.stallNudgeCooldownSec,
      }),
    );
    // 委託 run の進捗確認 (30 分周期)。 状態は delegation_runs の watchdog_* 列に永続。
    trackPostListenHandle(
      startDelegationRunWatchdog({
        runs: delegationRepo,
        sessions: repo,
        lastActivitySec: (sessionId) => transcriptLogs.tsSpan(sessionId)?.last_ts ?? null,
        resolveEnabled: () => adminState.getDelegationWatchdogEnabled(),
        resolveIdleSec: () => adminState.getDelegationWatchdogIdleSec(),
        resolveMaxNudges: () => adminState.getDelegationWatchdogMaxNudges(),
        intervalMs: cfg.delegationWatchdogIntervalMs,
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
      startGoalAndGo({
        repo,
        // 人間の回答待ちのセッションは自走継続しない (未回答質問が blocker)。
        hasPendingQuestion: pendingQuestionProbe(pendingQuestions),
        seconds: cfg.goalAndGoIdleSec,
        maxContinuations: cfg.goalAndGoMaxContinuations,
        maxRuntimeSec: cfg.goalAndGoMaxRuntimeSec,
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
    trackPostListenHandle(startErrorFixDispatcher({ sessions: repo, spawnDefaultCwd: cfg.spawnDefaultCwd }));
  }

  /**
   * listen 後に立ち上がるワークフロー実体の binding 登録。 登録直後に sync して
   * 有効なものだけ起動し、 以降はフラグの変化を watcher が拾って張り替える。
   */
  function registerPostListenWorkflowBindings(): void {
    workflowBindings.register({
      key: "test",
      name: "testing-branch-watch",
      start: () => startBranchWatch({ sessions: repo, claims: testingClaims, log }),
    });
    workflowBindings.register({
      key: "daily",
      name: "morning-scheduler",
      start: () => startMorningScheduler({ delegationService }),
    });
    workflowBindings.register({
      key: "daily",
      name: "cron-scheduler",
      start: () => startCronScheduler({
        delegationService,
        resolveCallNameOverride: (jobName) => adminState.getCronJobOverride(jobName),
      }),
    });
    workflowBindings.register({
      key: "review",
      name: "pr-ingest-watcher",
      start: () => startPrIngestWatcher({ sessions: repo, stats, prs }),
    });
    workflowBindings.register({
      key: "review",
      name: "pr-reconciler",
      start: () => startPrReconciler({
        prs,
        sessions: repo,
        tasks,
        revisor: revisorClient ?? undefined,
        isCcWorkflowEnabled: () => adminState.getCcWorkflowEnabled(),
        // develop に入った変更を確認待ちに積む (冪等)。 spec/feature/develop-confirm-flow.md §5。
        onDevelopMerge: async (event) => {
          const result = await intakeDevelopMerge(
            { repo: confirmRuns, memoria: memoriaClient, resolveServiceCode },
            event,
          );
          if (result.created) {
            const pr = prs.findByKey(event.repo_origin, event.pr_number);
            if (pr?.author_session_id) {
              notifyUserDecision({
                kind: "confirm-queued",
                targetSessionId: pr.author_session_id,
                mentionUserId: adminState.getMentionUserId(),
                text: `確認テストがキューに入りました。/confirm start ${result.row.service_code ?? result.row.repo_name} で開始してください。`,
              });
            }
          }
        },
      }),
    });
    workflowBindings.register({
      key: "review",
      name: "pr-full-sync",
      start: () => startPrFullSync({ prs }),
    });
    workflowBindings.register({
      key: "task",
      name: "task-reconciler",
      start: () => startTaskReconciler({ store: taskStore, backend: new MemoriaBackend(memoriaClient) }),
    });
    workflowBindings.register({
      key: "task",
      name: "taskflow-runtime",
      start: () => taskflowRuntime.start(),
    });
    workflowBindings.sync();
    workflowBindings.startWatching();
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

    const ready = await runBootPhases([
      {
        name: "seed-domain-data",
        run: () => {
          seedDefaultRules(rules);
          seedDelegationTemplates(delegationRepo);
          seedModelCatalog(modelCatalog);
          seedHarnessRules(harnessRepo);
          seedInjectManuals(injectManualsRepo);
        },
      },
      {
        name: "reset-runtime-ownership",
        run: () => {
          const resetCount = repo.resetAllWsClients();
          if (resetCount > 0) log.info({ count: resetCount }, "ws_clients reset after listen");
          startPostListenBackground();
        },
      },
      {
        name: "reaction-workflow",
        // 実行は workflow.reaction で gate するが、実装は起動時に準備する。
        // 無効時に読み込みまで飛ばすと、live 再有効化後も bot runner が bundled 実装に
        // 固定され、設定済みの外部プラグインを使えなくなる。
        run: () => initReactionWorkflow(workspaceRootDefault, log),
      },
    ], {
      shouldStop: () => shuttingDown,
      onComplete: (name, durationMs) => log.info({ phase: name, duration_ms: durationMs }, "boot phase complete"),
    });
    if (!ready) return;

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
  // 実行キュー: 再起動前に queued のまま残った run を拾い直し、 以後は定期 drain で流す。
  if (workflowEmbeddedEnabled() && !hasLiveWorkflowWorkerLease()) {
    delegationQueue.start();
    void delegationQueue.drain().catch((e) => log.warn(`delegation queue initial drain failed: ${(e as Error).message}`));
  } else if (workflowMode === "worker") {
    log.info("delegation workflow execution delegated to workflow-worker");
  } else {
    log.info("delegation embedded queue skipped: live workflow-worker lease found");
  }
  // TaskWorkflow の実体 (task-reconciler / taskflow-runtime) は
  // registerPostListenWorkflowBindings が workflow.task フラグに従って起動する。
  log.info({ duration_ms: Date.now() - startedAt }, "post-listen integrations started");
  }

  // event loop が同期処理で塞がれた事象を常時記録する。
  //
  // 塞がっている間は Discord interaction の 3 秒 ack に間に合わず 10062 (Unknown
  // interaction) になり、 ユーザには「コマンドが失敗した」 としか見えない。 2026-07-26 の
  // 調査では 14 秒の停止を「ログの空白」 から事後推測するしかなく、 発生頻度が低いため
  // CPU プロファイル (90 秒) でも捕まえられなかった。 stall を正確な時刻・長さ付きで
  // 残すことで、 次に踏んだときへ手掛かりを繋ぐ。
  const eventLoopStallMs = readPositiveIntEnv("CONCORDIA_EVENT_LOOP_STALL_MS", 1_000);
  const eventLoopMonitor = startEventLoopMonitor({
    stallThresholdMs: eventLoopStallMs,
    onStall: (stall) => {
      log.warn(
        {
          lag_ms: Math.round(stall.lagMs),
          active_handles: stall.activeHandles,
          active_requests: stall.activeRequests,
        },
        "event loop stalled",
      );
      recordEventLoopStall(stall);
    },
    onSummary: (summary) => {
      // 平穏な区間まで毎分出すとノイズになるので、 山が出たときだけ残す。
      if (summary.stalls === 0 && summary.maxLagMs < eventLoopStallMs / 2) return;
      log.info(
        {
          stalls: summary.stalls,
          max_lag_ms: Math.round(summary.maxLagMs),
          histogram_max_ms: Math.round(summary.histogramMaxMs),
          histogram_p99_ms: Math.round(summary.histogramP99Ms),
        },
        "event loop delay summary",
      );
    },
  });
  void eventLoopMonitor; // unref 済み。 プロセス終了は妨げない。

  const costWorkerWatch = setInterval(
    createCostLeaseWatchTick({
      mode: costMode,
      isWorkflowEnabled: () => isWorkflowEnabled("cost"),
      runtime: costRuntime,
      readLease: () => readCostWorkerLease(discordConfig),
      log,
      reportWorkerDown: (lastLease) => {
        eventBus.emit({
          type: "error.reported",
          source: "cost-worker-lease",
          message: "cost-worker lease expired; cost sampling is down (worker mode has no auto-fallback)",
          detail: lastLease ? { pid: lastLease.pid, last_heartbeat_ms: lastLease.ts } : {},
          ts: Math.floor(Date.now() / 1000),
        });
      },
    }),
    COST_WORKER_CHECK_MS,
  );
  costWorkerWatch.unref?.();

  let embeddedChatYielded = chatEmbeddedEnabled() && hasLiveChatWorkerLease();
  const chatWorkerWatch = setInterval(() => {
    if (!chatEmbeddedEnabled()) return;
    const workerActive = hasLiveChatWorkerLease();
    if (workerActive) {
      if (!discordBotHandle && !slackBotHandle && !embeddedChatYielded) return;
      embeddedChatYielded = true;
      log.warn("live chat-worker lease detected; stopping embedded chat relays");
      void Promise.all([
        stopDiscordBotManaged(),
        stopSlackBotManaged(),
        subsidiaryManager.stopAll().then(() => ({ ok: true })),
      ]).catch((error) => log.warn(`embedded chat relay stop failed: ${(error as Error).message}`));
      return;
    }
    if (!embeddedChatYielded) return;
    embeddedChatYielded = false;
    log.warn("chat-worker lease expired; restoring embedded chat relays");
    void Promise.all([
      startDiscordBotManaged(),
      startSlackBotManaged(),
      discordSubsidiaryAutostartEnabled() ? subsidiaryManager.startAll().then(() => ({ ok: true })) : Promise.resolve({ ok: true }),
    ]).catch((error) => log.warn(`embedded chat relay restore failed: ${(error as Error).message}`));
  }, CHAT_WORKER_CHECK_MS);
  chatWorkerWatch.unref?.();

  let embeddedWorkflowYielded = workflowEmbeddedEnabled() && hasLiveWorkflowWorkerLease();
  const workflowWorkerWatch = setInterval(() => {
    if (!workflowEmbeddedEnabled()) return;
    const workerActive = hasLiveWorkflowWorkerLease();
    if (workerActive && !embeddedWorkflowYielded) {
      embeddedWorkflowYielded = true;
      delegationQueue.stop();
      log.warn("live workflow-worker lease detected; stopping embedded delegation queue");
      return;
    }
    if (!workerActive && embeddedWorkflowYielded) {
      embeddedWorkflowYielded = false;
      delegationQueue.start();
      void delegationQueue.drain().catch((error) =>
        log.warn(`delegation queue fallback drain failed: ${(error as Error).message}`),
      );
      log.warn("workflow-worker lease expired; restoring embedded delegation queue");
    }
  }, WORKFLOW_WORKER_CHECK_MS);
  workflowWorkerWatch.unref?.();

  // Slack-UI bot（Discord と並ぶ ChatPlatform）。CONCORDIA_SLACK_ENABLED が
  // 無ければ完全 no-op。spec/feature/slack-platform.md

  // 子会社 Bot: enabled な子会社を一括起動 (本社 bot と同じ 3 カテゴリ自動作成 +
  // subsidiary-only 可視 + ガードゲート)。 spec/feature/subsidiary-delegation.md

  const resources = new ResourceOwner((message) => log.warn(message));
  resources.own("workflow bindings", () => workflowBindings.stop());
  resources.own("web push", () => stopWebPushService());
  resources.own("sweeper", () => sweeper.stop());
  resources.own("delegation queue", () => delegationQueue.stop());
  resources.own("post-listen handles", () => {
    for (const handle of postListenHandles.splice(0).reverse()) {
      try { handle.stop(); }
      catch (error) { log.warn(`post-listen handle stop failed: ${(error as Error).message}`); }
    }
  });
  resources.own("session message subscription", () => stopMessageService());
  resources.own("worker lease watchers", () => {
    clearInterval(costWorkerWatch);
    clearInterval(chatWorkerWatch);
    clearInterval(workflowWorkerWatch);
  });
  resources.own("cost runtime", () => costRuntime.stop());
  resources.own("discord restart timer", () => clearDiscordBotAutoRestart());
  resources.own("post-listen startup", () => postListenStartup.catch(() => {}));
  resources.own("discord bot", () => stopDiscordBotManaged());
  resources.own("slack bot", () => stopSlackBotManaged());
  resources.own("subsidiary bots", () => subsidiaryManager.stopAll());
  resources.own("managed processes", () => processManager.stopAll());
  resources.own("websocket server", () => ws.close());

  // 連合 (マルチ拠点) の起動 — opt-in。listener は /v1 とは別ポート・別 origin の
  // 専用面 (Phase 0 信頼境界。既定 host は 127.0.0.1、外部公開はトンネル前提)。
  // 個々のロールの起動失敗は runtime 側で報告され、本体は続行する。
  await federation.startRoles();
  resources.own("federation", () => federation.stop());
  resources.own("http server", () => { server.close(); });
  resources.own("database", () => closeDb());

  return {
    port: cfg.port,
    shutdown: async () => {
      shuttingDown = true;
      await resources.closeInOrder();
    },
  };
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
