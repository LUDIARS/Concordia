/**
 * Hono app factory.
 */

import { Hono } from "hono";
import { spawn } from "node:child_process";
import type { SessionsRepo } from "./db/sessions-repo.js";
import type { TasksRepo } from "./db/tasks-repo.js";
import type { ChatRepo } from "./db/chat-repo.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ConcordiaConfig } from "./shared/config.js";
import { sessionsRouter } from "./api/sessions.js";
import { reportsRouter } from "./api/reports.js";
import { monitorRouter } from "./api/monitor.js";
import { chatRouter } from "./api/chat.js";
import { setupRouter } from "./api/setup.js";
import { skillsRouter } from "./api/skills.js";
import { streamRouter } from "./api/stream.js";
import { rulesRouter } from "./api/rules.js";
import { dailyRouter } from "./api/daily.js";
import { processesRouter } from "./api/processes.js";
import { statRouter } from "./api/stat.js";
import type { ProcessManager } from "./processes/manager.js";
import type { ProcessesRepo } from "./db/processes-repo.js";
import type { SkillsRepo } from "./db/skills-repo.js";
import type { RulesRepo } from "./db/rules-repo.js";
import type { DayReportsRepo } from "./db/day-reports-repo.js";
import type { PersonasRepo } from "./db/personas-repo.js";
import type { StatsRepo } from "./db/stats-repo.js";
import type { SchedulerHandle } from "./daily/scheduler.js";
import { personasRouter } from "./api/personas.js";

export interface AppDeps {
  /** observability layer (Excubitor 由来) の Hono router. 内部で /api/v1/... の絶対 path を持つ. */
  observabilityRouter?: Hono;
  repo: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  skills: SkillsRepo;
  rules: RulesRepo;
  dayReports: DayReportsRepo;
  personas: PersonasRepo;
  processes: ProcessesRepo;
  stats: StatsRepo;
  processManager: ProcessManager;
  dailyScheduler: SchedulerHandle;
  dispatcher: Dispatcher;
  config: ConcordiaConfig;
  startedAt: string;
  sweeperRunOnce: () => void;
  /** tools/concordia-hook.mjs の絶対パス (setup endpoint で配信) */
  toolPath: string;
  /** 公開 URL (setup endpoint で配信) */
  publicUrl: string;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "concordia", version: "0.1.0", started_at: deps.startedAt }),
  );

  app.route(
    "/v1/sessions",
    sessionsRouter({
      repo: deps.repo,
      tasks: deps.tasks,
      chat: deps.chat,
      config: deps.config,
      dispatcher: deps.dispatcher,
      personas: deps.personas,
      processManager: deps.processManager,
    }),
  );
  app.route("/v1/processes", processesRouter({ manager: deps.processManager, repo: deps.processes }));
  app.route(
    "/v1/personas",
    personasRouter({ personas: deps.personas, sessions: deps.repo, chat: deps.chat, config: deps.config }),
  );
  app.route("/v1/reports", reportsRouter({ repo: deps.repo, config: deps.config }));
  app.route("/v1/monitor", monitorRouter({ repo: deps.repo }));
  app.route("/v1/chat", chatRouter({ chat: deps.chat, dispatcher: deps.dispatcher }));
  app.route("/v1/setup", setupRouter({ toolPath: deps.toolPath, url: deps.publicUrl }));
  app.route("/v1/skills", skillsRouter({ skills: deps.skills }));
  app.route("/v1/stream", streamRouter());
  app.route("/v1/rules", rulesRouter({ rules: deps.rules }));
  app.route("/v1/stat", statRouter({ stats: deps.stats, sessions: deps.repo }));
  app.route(
    "/v1/daily-reports",
    dailyRouter({ dayReports: deps.dayReports, scheduler: deps.dailyScheduler }),
  );

  app.post("/v1/sweeper/run", (c) => {
    deps.sweeperRunOnce();
    return c.json({ ok: true });
  });

  // 管理 API: noise sessions の手動 truncate
  app.post("/v1/admin/truncate-sessions", (c) => {
    const n = deps.repo.truncateAllSessions();
    return c.json({ ok: true, deleted: n });
  });

  // 管理 API: 新コード反映用の self-restart.
  // 子プロセスとして `npm run dev:backend` を detach spawn → 自分は 300ms 後に process.exit(0).
  // listen socket は exit で OS が回収. 数 100ms の downtime あり (in-flight request は drop).
  // loopback (127.0.0.1) でしか上がってない前提で、 追加認証は付けない.
  // test 時は CONCORDIA_RESTART_DRY_RUN=1 で spawn/exit を skip.
  app.post("/v1/admin/restart", (c) => {
    if (process.env.CONCORDIA_RESTART_DRY_RUN === "1") {
      return c.json({ ok: true, dry_run: true });
    }
    setTimeout(() => {
      const child = spawn("npm", ["run", "dev:backend"], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        shell: true, // Windows: npm.cmd を OS shell に解決させる
      });
      child.unref();
      setTimeout(() => process.exit(0), 200);
    }, 100);
    return c.json({ ok: true, message: "restarting (child spawning, parent will exit in ~300ms)" });
  });

  // observability (Excubitor 由来) は内部で /api/v1/... の絶対 path を持つので root mount.
  if (deps.observabilityRouter) {
    app.route("/", deps.observabilityRouter);
  }

  return app;
}
