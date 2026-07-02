/**
 * Standalone Discord relay process.
 *
 * Run the backend with CONCORDIA_DISCORD_EMBEDDED=0, then start this worker in
 * a separate process. Backend HTTP/schedulers stay responsive even if Discord
 * gateway relay or session egress becomes busy.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { loadConfig } from "./shared/config.js";
import { createChildLogger } from "./shared/logger.js";
import { openDb, closeDb } from "./db/index.js";
import { SessionsRepo } from "./db/sessions-repo.js";
import { ChatRepo } from "./db/chat-repo.js";
import { PersonasRepo } from "./db/personas-repo.js";
import { TasksRepo } from "./db/tasks-repo.js";
import { SessionTaskRecordsRepo } from "./db/session-task-records-repo.js";
import { PrRecordsRepo } from "./db/pr-records-repo.js";
import { DelegationRepo } from "./db/delegation-repo.js";
import { DelegationService } from "./delegation/service.js";
import { SubsidiaryRepo } from "./db/subsidiary-repo.js";
import { HarnessRulesRepo } from "./db/harness-rules-repo.js";
import { SubsidiaryBudgetTracker } from "./subsidiary/budget.js";
import { SubsidiaryBotManager } from "./subsidiary/manager.js";
import { AdminState } from "./admin/state.js";
import { resolveDiscordConfig } from "./discord/conn-config.js";
import { startDiscordBot, type DiscordBotDeps, type DiscordBotHandle } from "./discord/bot.js";
import { initReactionWorkflow } from "./platform/reaction-workflow-loader.js";
import type { WorkflowAction } from "./platform/reaction-workflow.js";
import { runClaude } from "./rules/claude-runner.js";
import { makeDiscordConfigRepo, makeDiscordSessionChannelsRepo } from "./db/discord-repo.js";
import { loadSecretBox } from "./shared/secret-box.js";
import { eventBus, type ConcordiaEvent } from "./events.js";
import { startWorkerLease } from "./discord/relay-owner.js";

const log = createChildLogger("discord-worker");
const RECONNECT_MS = 3_000;
/** 定期 reconcile の間隔 (WS 切断中に取りこぼした session.started の救済)。 */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

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

interface WsBridge {
  stop(): void;
}

function startWsBridge(wsUrl: string, onOpen?: () => void): WsBridge {
  let stopped = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      log.info(`connected to backend ws ${wsUrl}`);
      onOpen?.();
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: unknown };
        if (msg.type === "hello") return;
        if (typeof msg.type !== "string") return;
        eventBus.emit(msg as ConcordiaEvent);
      } catch (e) {
        log.warn(`ws event parse failed: ${(e as Error).message}`);
      }
    });
    ws.on("close", () => {
      if (stopped) return;
      log.warn(`backend ws closed; reconnecting in ${RECONNECT_MS}ms`);
      retry = setTimeout(connect, RECONNECT_MS);
      retry.unref?.();
    });
    ws.on("error", (e) => {
      log.warn(`backend ws error: ${(e as Error).message}`);
    });
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      try { ws?.close(); } catch {}
    },
  };
}

function postInject(concordiaUrl: string): DiscordBotDeps["emitSessionInject"] {
  return (sessionId, text, source) => {
    void fetch(`${concordiaUrl}/v1/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, source }),
    }).catch((e) => log.warn(`remote inject failed session=${sessionId}: ${(e as Error).message}`));
  };
}

async function main(): Promise<void> {
  loadDotEnv(join(process.cwd(), ".env"));
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const repo = new SessionsRepo(db);
  const chat = new ChatRepo(db);
  const personas = new PersonasRepo(db);
  const tasks = new TasksRepo(db);
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  const prs = new PrRecordsRepo(db);
  const discordConfig = makeDiscordConfigRepo(db);
  const secretBox = loadSecretBox({
    envValue: process.env.CONCORDIA_SECRET_KEY,
    keyFile: join(process.cwd(), "concordia.secret.key"),
  });

  const workspaceRootDefault = cfg.workspaceRoot || cfg.spawnDefaultCwd;
  const adminState = new AdminState(db, {
    workspaceRoot: workspaceRootDefault,
    workspaceRoots: cfg.workspaceRoots.length ? cfg.workspaceRoots : (workspaceRootDefault ? [workspaceRootDefault] : []),
    githubOrg: cfg.githubOrg,
    reactionWorkflowEnabled: process.env.CONCORDIA_REACTION_WORKFLOW === "1",
    lictorDevPath: workspaceRootDefault ? join(workspaceRootDefault, "Lictor") : "",
  });
  await initReactionWorkflow(workspaceRootDefault, log);

  const concordiaUrl = `http://${cfg.host}:${cfg.port}`;
  // relay 所有権 lease: embedded bot との二重起動 (interaction 二重 dispatch /
  // spawn 二重実行) を機械的に防ぐ。 embedded 側は live な lease を見て退く。
  const relayLease = startWorkerLease(discordConfig);
  // WS 切断中に発火した session.started は再送されない。 接続 (再接続) 時と定期で、
  // 「active なのにセッションチャンネル未作成」 のセッションへ合成 session.started を
  // 流して救済する (onSessionRegistered は既知セッションを no-op する冪等実装)。
  const headOfficeChannels = makeDiscordSessionChannelsRepo(db);
  const reconcileMissedSessions = () => {
    try {
      const known = new Set(headOfficeChannels.listActive().map((r) => r.session_id));
      for (const s of repo.listSessions({ status: "active" })) {
        if (known.has(s.id)) continue;
        eventBus.emit({
          type: "session.started",
          session_id: s.id,
          provider: s.provider ?? "",
          repo_path: s.repo_path,
          branch: s.branch,
          ts: Date.now(),
        });
      }
    } catch (e) {
      log.warn(`session reconcile failed: ${(e as Error).message}`);
    }
  };
  const bridge = startWsBridge(`ws://${cfg.host}:${cfg.port}/ws`, () => {
    // bot 側の layout 準備を待つ猶予をとってから救済する (起動直後の空振り回避)。
    setTimeout(reconcileMissedSessions, 10_000).unref?.();
  });
  const reconcileTimer = setInterval(reconcileMissedSessions, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
  const emitSessionInject = postInject(concordiaUrl);
  const delegationRepo = new DelegationRepo(db);
  const subsidiaryRepo = new SubsidiaryRepo(db);
  const harnessRepo = new HarnessRulesRepo(db);
  const delegationService = new DelegationService({
    repo: delegationRepo,
    personas,
    concordiaUrl,
  });
  const subsidiaryBudget = new SubsidiaryBudgetTracker({ sessionsRepo: repo });

  const discordBotDeps: DiscordBotDeps = {
    db,
    chatRepo: chat,
    sessionsRepo: repo,
    sessionTaskRecordsRepo: sessionTaskRecords,
    tasksRepo: tasks,
    personasRepo: personas,
    prRecordsRepo: prs,
    listSubsidiaries: () =>
      subsidiaryRepo.list().map((s) => ({ id: s.id, name: s.display_name || s.name, daily_token_budget: s.daily_token_budget })),
    concordiaUrl,
    workspaceRoot: workspaceRootDefault,
    resolveWorkspaceRoot: () => adminState.getWorkspaceRoot(),
    resolveWorkspaceRoots: () => adminState.getWorkspaceRoots(),
    resolveReactionWorkflowEnabled: () => adminState.getReactionWorkflowEnabled(),
    resolveReactionMappings: () => adminState.getReactionEmojiOverrides() as Record<string, WorkflowAction>,
    resolveConfig: () => resolveDiscordConfig(discordConfig, secretBox),
    emitSessionInject,
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
      const { resolveConfig: _resolveConfig, subsidiary: _subsidiary, ...base } = discordBotDeps;
      return base;
    },
  });

  const bot: DiscordBotHandle | null = await startDiscordBot(discordBotDeps);
  await subsidiaryManager.startAll().catch((e) => log.warn(`subsidiary bots init failed: ${(e as Error).message}`));
  log.info("Discord worker started");

  const shutdown = async () => {
    clearInterval(reconcileTimer);
    relayLease.stop();
    bridge.stop();
    await subsidiaryManager.stopAll().catch(() => {});
    if (bot) await bot.stop().catch(() => {});
    closeDb();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
}

main().catch((err) => {
  log.error({ err }, "Discord worker failed");
  process.exit(1);
});
