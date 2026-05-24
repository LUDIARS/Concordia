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
import { TasksRepo } from "./db/tasks-repo.js";
import { ChatRepo } from "./db/chat-repo.js";
import { SkillsRepo } from "./db/skills-repo.js";
import { RulesRepo, seedDefaultRules } from "./db/rules-repo.js";
import { DayReportsRepo } from "./db/day-reports-repo.js";
import { PersonasRepo } from "./db/personas-repo.js";
import { ProcessesRepo } from "./db/processes-repo.js";
import { StatsRepo } from "./db/stats-repo.js";
import { SessionTaskRecordsRepo } from "./db/session-task-records-repo.js";
import { ProcessManager } from "./processes/manager.js";
import { seedPersonas } from "./personas/seeds.js";
import { Dispatcher } from "./dispatcher.js";
import { startSweeper } from "./sweeper.js";
import { startRuleEngine } from "./rules/engine.js";
import { startRuleProposer } from "./rules/proposer.js";
import { startDailyScheduler } from "./daily/scheduler.js";
import { startStatScheduler } from "./stat/scheduler.js";
import { buildApp } from "./app.js";
import { attachWsServer } from "./api/ws.js";
import { eventBus } from "./events.js";
import { bootObservability } from "./observability/index.js";

const log = createChildLogger("server");

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
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  seedDefaultRules(rules);
  seedPersonas(personas);
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat });
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

  // Observability layer (Excubitor 由来). 失敗しても Concordia 本体は止めない.
  let observabilityHandle: Awaited<ReturnType<typeof bootObservability>> | null = null;
  try {
    observabilityHandle = await bootObservability();
    log.info("observability layer booted");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "observability layer boot failed; continuing without it");
  }

  const app = buildApp({
    observabilityRouter: observabilityHandle?.router,
    repo,
    tasks,
    chat,
    skills,
    rules,
    dayReports,
    personas,
    processes,
    stats,
    sessionTaskRecords,
    processManager,
    dailyScheduler,
    dispatcher,
    config: cfg,
    startedAt: new Date().toISOString(),
    sweeperRunOnce: sweeper.runOnce,
    toolPath,
    publicUrl,
  });

  const ruleEngine = startRuleEngine({
    rules,
    sessions: repo,
    chat,
    disable_claude: process.env.CONCORDIA_DISABLE_CLAUDE === "1",
  });

  // 5 分おきに新しいチャット発言フック rule を AI に提案させる固定機能
  const ruleProposer = startRuleProposer({
    rules,
    sessions: repo,
    chat,
    disable_claude: process.env.CONCORDIA_DISABLE_CLAUDE === "1",
    maxAiRules: cfg.maxAiRules,
  });

  // 10 分毎に active session に stat-collect を enqueue する scheduler.
  // フラットエージェントチームでの相互状況共有用 (各 session の現況を JSON で蓄積).
  const statScheduler = startStatScheduler({
    sessions: repo,
    stats,
    tasks,
  });

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

  return {
    port: cfg.port,
    shutdown: async () => {
      dailyScheduler.stop();
      ruleProposer.stop();
      ruleEngine.stop();
      statScheduler.stop();
      sweeper.stop();
      unsubLog();
      if (observabilityHandle) {
        try { await observabilityHandle.shutdown(); } catch { /* noop */ }
      }
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
