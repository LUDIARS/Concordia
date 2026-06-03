/**
 * Concordia backend エントリポイント.
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./shared/config.js";
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
import { AdminState } from "./admin/state.js";
import { ProcessManager } from "./processes/manager.js";
import { seedPersonas } from "./personas/seeds.js";
import { collectBoyakiToPersona } from "./personas/boyaki.js";
import { Dispatcher } from "./dispatcher.js";
import { startSweeper } from "./sweeper.js";
import { startRuleEngine } from "./rules/engine.js";
import { startRuleProposer } from "./rules/proposer.js";
import { startDailyScheduler } from "./daily/scheduler.js";
import { startStatScheduler } from "./stat/scheduler.js";
import { startRepoChangeWatcher } from "./stat/repo-change-watcher.js";
import { startPrIngestWatcher } from "./pr/ingest.js";
import { startPrReconciler } from "./pr/reconcile.js";
import { startErrorFixDispatcher } from "./control/error-fix.js";
import { buildApp } from "./app.js";
import { attachWsServer } from "./api/ws.js";
import { eventBus } from "./events.js";
import type { DiscordBotDeps, DiscordBotHandle } from "./discord/bot.js";
import { startDiscordBot } from "./discord/bot.js";
import type { SlackBotDeps } from "./slack/bot.js";
import { startSlackBot } from "./slack/bot.js";
import type { ChatPlatform } from "./platform/chat-platform.js";

const log = createChildLogger("server");
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

async function stopSlackBotManaged(): Promise<void> {
  if (!slackBotHandle) return;
  try { await slackBotHandle.stop(); } catch {}
  slackBotHandle = null;
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
  const participants = makeParticipantsRepo(db);
  const delegationRepo = new DelegationRepo(db);
  const delegationService = new DelegationService({ repo: delegationRepo });
  const adminState = new AdminState(db);
  seedDefaultRules(rules);
  seedPersonas(personas);
  seedDelegationTemplates(delegationRepo);
  const dispatcher = new Dispatcher({
    sessions: repo,
    tasks,
    chat,
    isChatMuted: () => adminState.getChatMuted(),
  });
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

  const toolPath = join(process.cwd(), "tools", "concordia-hook.mjs");
  const publicUrl = `http://${cfg.host}:${cfg.port}`;

  const dailyScheduler = startDailyScheduler({
    sessions: repo,
    dayReports,
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
    concordiaUrl: publicUrl,
  };
  slackBotDeps = {
    db,
    chatRepo: chat,
    sessionsRepo: repo,
    personasRepo: personas,
    concordiaUrl: publicUrl,
  };

  const app = buildApp({
    repo,
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
    discordConfig,
    participants,
    delegation: delegationRepo,
    delegationService,
    adminState,
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
  });

  const ruleEngine = startRuleEngine({
    rules,
    sessions: repo,
    chat,
    disable_claude: process.env.CONCORDIA_DISABLE_CLAUDE === "1",
    rulesDisabled: () => !adminState.getRulesEnabled(),
  });

  // 既定 5 分間隔で chat post 用 rule を AI に提案させる. interval は admin で変更可.
  const ruleProposer = startRuleProposer({
    rules,
    sessions: repo,
    chat,
    disable_claude: process.env.CONCORDIA_DISABLE_CLAUDE === "1",
    maxAiRules: cfg.maxAiRules,
    rulesDisabled: () => !adminState.getRulesEnabled(),
    intervalSec: () => adminState.getRuleProposerIntervalSec(),
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
      llm: cfg.anthropicApiKey ? "available (unused in v0.1)" : "disabled",
    },
    "Concordia listening",
  );

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

  return {
    port: cfg.port,
    shutdown: async () => {
      dailyScheduler.stop();
      ruleProposer.stop();
      ruleEngine.stop();
      statScheduler.stop();
      repoChangeWatcher.stop();
      prIngestWatcher.stop();
      prReconciler.stop();
      errorFixDispatcher.stop();
      sweeper.stop();
      unsubLog();
      await stopDiscordBotManaged();
      await stopSlackBotManaged();
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
