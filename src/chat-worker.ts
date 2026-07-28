/**
 * Standalone Discord/Slack relay.
 *
 * Interactive acknowledgement and read-model rendering stay in this process.
 * The backend WS is asynchronous event input only; SQLite WAL is the read-model boundary.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { loadConfig, isLoopbackHost } from "./shared/config.js";
import { createChildLogger } from "./shared/logger.js";
import { openDb, closeDb } from "./db/index.js";
import { SessionsRepo } from "./db/sessions-repo.js";
import { ChatRepo } from "./db/chat-repo.js";
import { TasksRepo } from "./db/tasks-repo.js";
import { SessionTaskRecordsRepo } from "./db/session-task-records-repo.js";
import { PrRecordsRepo } from "./db/pr-records-repo.js";
import { DelegationRepo } from "./db/delegation-repo.js";
import { DelegationService } from "./delegation/service.js";
import { DelegationEffortBlackbox } from "./delegation/effort-blackbox.js";
import { SubsidiaryRepo } from "./db/subsidiary-repo.js";
import { HarnessRulesRepo } from "./db/harness-rules-repo.js";
import { SubsidiaryBudgetTracker } from "./subsidiary/budget.js";
import { SubsidiaryBotManager } from "./subsidiary/manager.js";
import { AdminState } from "./admin/state.js";
import { resolveDiscordConfig } from "./discord/conn-config.js";
import { DEFAULT_DESK_CHANNEL_NAME } from "./discord/config.js";
import { startDiscordBot, type DiscordBotDeps, type DiscordBotHandle } from "./discord/bot.js";
import { startSlackBot, type SlackBotDeps } from "./slack/bot.js";
import { makeChatReadModel } from "./api/chat-read-models.js";
import { initReactionWorkflow } from "./platform/reaction-workflow-loader.js";
import type { WorkflowAction } from "./platform/reaction-workflow.js";
import { runClaude } from "./rules/claude-runner.js";
import { repinSession } from "./control/repin-session.js";
import { resolveAgentHomeCwd, setWorkspaceRootsResolver } from "./control/spawner.js";
import { makeDiscordConfigRepo, makeDiscordPendingQuestionsRepo, makeDiscordSessionChannelsRepo } from "./db/discord-repo.js";
import { makeSlackConfigRepo } from "./db/slack-config-repo.js";
import { resolveSlackConfig } from "./slack/config.js";
import { loadSecretBox } from "./shared/secret-box.js";
import { eventBus } from "./events.js";
import { eventFromWsFrame, parseWsFrame } from "./shared/event-schema.js";
import { isReactionUserAllowed, normalizeReactionUserIds } from "./shared/reaction-workflow-auth.js";
import { getReactionWorkflowReadiness } from "./shared/reaction-workflow-readiness.js";
import { readChatWorkerLease, startChatWorkerLease } from "./bootstrap/chat.js";
import { ChatMutationOutboxRepo } from "./db/chat-mutation-outbox-repo.js";
import { installChatMutationOutbox } from "./platform/chat-mutation-outbox.js";
import { ExcubitorClient } from "./excubitor/client.js";
import { createRevisorTestWorkflowClientFromEnv } from "./pr/revisor-test-workflow-client.js";

const log = createChildLogger("chat-worker");
const RECONNECT_MS = 3_000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

interface WsBridge { stop(): void }

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function startChatWorkerWsBridge(wsUrl: string, onOpen?: () => void): WsBridge {
  let stopped = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = (): void => {
    if (stopped) return;
    ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      log.info(`connected to backend ws ${wsUrl}`);
      onOpen?.();
    });
    ws.on("message", (raw) => {
      try {
        const parsed = parseWsFrame(JSON.parse(raw.toString()));
        if (!parsed.ok) {
          log.warn(`ws event rejected reason=${parsed.reason} type=${parsed.type ?? "-"}`);
          return;
        }
        if (parsed.frame.type === "hello") return;
        eventBus.emit(eventFromWsFrame(parsed.frame));
      } catch (error) {
        log.warn(`ws event parse failed: ${(error as Error).message}`);
      }
    });
    ws.on("close", () => {
      if (stopped) return;
      log.warn(`backend ws closed; reconnecting in ${RECONNECT_MS}ms`);
      retry = setTimeout(connect, RECONNECT_MS);
      retry.unref?.();
    });
    ws.on("error", (error) => log.warn(`backend ws error: ${(error as Error).message}`));
  };
  connect();
  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      try { ws?.close(); } catch { /* best-effort */ }
    },
  };
}

function postInject(concordiaUrl: string): DiscordBotDeps["emitSessionInject"] {
  return (sessionId, text, source) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    void fetch(`${concordiaUrl}/v1/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, source }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((error) => log.warn(`remote inject failed session=${sessionId}: ${(error as Error).message}`));
  };
}

async function main(): Promise<void> {
  loadDotEnv(join(process.cwd(), ".env"));
  process.env.CONCORDIA_CHAT_PROCESS_ROLE = "worker";
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const sessions = new SessionsRepo(db);
  const chat = new ChatRepo(db);
  const tasks = new TasksRepo(db);
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  const prs = new PrRecordsRepo(db);
  const discordConfig = makeDiscordConfigRepo(db);
  const existingLease = readChatWorkerLease(discordConfig);
  if (existingLease && existingLease.pid !== process.pid) {
    throw new Error(`chat-worker already active pid=${existingLease.pid}`);
  }
  const lease = startChatWorkerLease(discordConfig);
  const slackConfig = makeSlackConfigRepo(db);
  const secretBox = loadSecretBox({
    envValue: process.env.CONCORDIA_SECRET_KEY,
    keyFile: join(process.cwd(), "concordia.secret.key"),
  });
  const workspaceRoot = cfg.workspaceRoot || cfg.spawnDefaultCwd;
  const adminState = new AdminState(db, {
    workspaceRoot,
    workspaceRoots: cfg.workspaceRoots.length ? cfg.workspaceRoots : (workspaceRoot ? [workspaceRoot] : []),
    githubOrg: cfg.githubOrg,
    reactionWorkflowEnabled: process.env.CONCORDIA_REACTION_WORKFLOW === "1",
    reactionWorkflowDiscordUserIds: normalizeReactionUserIds(
      process.env.CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS,
    ),
    reactionWorkflowSlackUserIds: normalizeReactionUserIds(
      process.env.CONCORDIA_REACTION_WORKFLOW_SLACK_USERS,
    ),
    lictorDevPath: workspaceRoot ? join(workspaceRoot, "Lictor") : "",
  });
  setWorkspaceRootsResolver(() => adminState.getWorkspaceRoots());
  const reactionWorkflowReadiness = getReactionWorkflowReadiness({
    enabled: adminState.getReactionWorkflowEnabled(),
    discordUserIds: adminState.getReactionWorkflowDiscordUserIds(),
    slackUserIds: adminState.getReactionWorkflowSlackUserIds(),
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
  await initReactionWorkflow(workspaceRoot, log);

  const backendHost = isLoopbackHost(cfg.host) ? cfg.host : "127.0.0.1";
  const concordiaUrl = `http://${backendHost}:${cfg.port}`;
  const wsUrl = `ws://${backendHost}:${cfg.port}/ws`;
  const mutationOutbox = installChatMutationOutbox({
    baseUrl: concordiaUrl,
    repo: new ChatMutationOutboxRepo(db),
    log,
  });
  const channels = makeDiscordSessionChannelsRepo(db);
  const pendingQuestions = makeDiscordPendingQuestionsRepo(db);
  const reconcileMissedSessions = (): void => {
    const known = new Set(channels.listActive().map((row) => row.session_id));
    for (const session of sessions.listSessions({ status: "active" })) {
      if (known.has(session.id)) continue;
      eventBus.emit({
        type: "session.started",
        session_id: session.id,
        provider: session.provider,
        repo_path: session.repo_path,
        branch: session.branch,
        ts: Math.floor(Date.now() / 1000),
      });
    }
  };
  const bridge = startChatWorkerWsBridge(wsUrl, () => {
    const timer = setTimeout(reconcileMissedSessions, 10_000);
    timer.unref?.();
  });
  const reconcileTimer = setInterval(reconcileMissedSessions, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  const delegationRepo = new DelegationRepo(db);
  const subsidiaryRepo = new SubsidiaryRepo(db);
  const harnessRepo = new HarnessRulesRepo(db);
  const delegationService = new DelegationService({
    repo: delegationRepo,
    concordiaUrl,
    effortBlackbox: new DelegationEffortBlackbox(db, runClaude),
  });
  const subsidiaryBudget = new SubsidiaryBudgetTracker({ sessionsRepo: sessions });
  const readModel = makeChatReadModel({
    chatRepo: chat,
    sessionsRepo: sessions,
    sessionTaskRecordsRepo: sessionTaskRecords,
    tasksRepo: tasks,
    prRecordsRepo: prs,
    hasPendingQuestion: (sessionId) => pendingQuestions.findLatestUnanswered(sessionId) !== null,
    delegationRepo,
  });

  const discordDeps: DiscordBotDeps = {
    db,
    readModel,
    chatRepo: chat,
    sessionsRepo: sessions,
    revisorTestWorkflow: createRevisorTestWorkflowClientFromEnv(new ExcubitorClient()) ?? undefined,
    listSubsidiaries: () => subsidiaryRepo.list().map((row) => ({
      id: row.id,
      name: row.display_name || row.name,
      daily_token_budget: row.daily_token_budget,
    })),
    concordiaUrl,
    workspaceRoot,
    resolveWorkspaceRoot: () => adminState.getWorkspaceRoot(),
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
    resolveSessionSpawnCwd: (provider, requested) =>
      resolveAgentHomeCwd(provider, requested, adminState.getWorkspaceRoot()),
    resolveReactionWorkflowEnabled: () => adminState.getReactionWorkflowEnabled(),
    resolveReactionMappings: () => adminState.getReactionEmojiOverrides() as Record<string, WorkflowAction>,
    isReactionWorkflowUserAllowed: (userId) =>
      isReactionUserAllowed(adminState.getReactionWorkflowDiscordUserIds(), userId),
    isLaunchUserAllowed: (userId) =>
      isReactionUserAllowed(adminState.getReactionWorkflowDiscordUserIds(), userId),
    runHeadless: runClaude,
    repinSession: (sessionId) => repinSession(sessions, sessionId),
    resolveConfig: () => resolveDiscordConfig(discordConfig, secretBox),
    emitSessionInject: postInject(concordiaUrl),
  };
  const slackDeps: SlackBotDeps = {
    db,
    readModel,
    slackConfigRepo: slackConfig,
    concordiaUrl,
    workspaceRoot,
    resolveWorkspaceRoot: () => adminState.getWorkspaceRoot(),
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
    resolveReactionWorkflowEnabled: () => adminState.getReactionWorkflowEnabled(),
    resolveReactionMappings: () => adminState.getReactionEmojiOverrides() as Record<string, WorkflowAction>,
    isReactionWorkflowUserAllowed: (userId) =>
      isReactionUserAllowed(adminState.getReactionWorkflowSlackUserIds(), userId),
    isLaunchUserAllowed: (userId) =>
      isReactionUserAllowed(adminState.getReactionWorkflowSlackUserIds(), userId),
    runHeadless: runClaude,
    resolveConfig: () => resolveSlackConfig(slackConfig, secretBox),
  };
  const subsidiaryManager = new SubsidiaryBotManager({
    subsidiaryRepo,
    harnessRepo,
    delegationRepo,
    delegationService,
    headOfficeDiscord: () => resolveDiscordConfig(discordConfig, secretBox),
    runClaude,
    budgetTracker: subsidiaryBudget,
    baseDiscordDeps: () => {
      const { resolveConfig: _config, subsidiary: _subsidiary, ...base } = discordDeps;
      return base;
    },
    startBot: (deps) => startDiscordBot(deps as DiscordBotDeps),
  });
  const desks = subsidiaryRepo.listEnabledDesks();
  const desk = desks[0];
  const deskRuntime: DiscordBotDeps["desk"] = desk ? (() => {
    const processor = subsidiaryManager.processorFor(desk.id);
    return {
      id: desk.id,
      channelName: desk.display_name?.trim() || DEFAULT_DESK_CHANNEL_NAME,
      channelId: desk.channel_id,
      process: processor.process,
      isLocked: processor.isLocked,
      onChannelResolved: (channelId: string) => subsidiaryRepo.update(desk.id, { channel_id: channelId }),
    };
  })() : undefined;

  const discordBot: DiscordBotHandle | null = await startDiscordBot({ ...discordDeps, desk: deskRuntime });
  const slackBot = await startSlackBot(slackDeps);
  await subsidiaryManager.startAll();
  log.info("chat worker started (SQLite read-model; async WS events)");

  const shutdown = async (): Promise<void> => {
    clearInterval(reconcileTimer);
    mutationOutbox.stop();
    bridge.stop();
    await subsidiaryManager.stopAll().catch(() => {});
    if (discordBot) await discordBot.stop().catch(() => {});
    if (slackBot) await slackBot.stop().catch(() => {});
    lease.stop();
    closeDb();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
}

main().catch((error) => {
  log.error({ err: error }, "chat worker failed");
  process.exit(1);
});
