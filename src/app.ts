/**
 * Hono app factory.
 */

import { Hono } from "hono";
import { spawn } from "node:child_process";
import type { SessionsRepo } from "./db/sessions-repo.js";
import type { ParticipantsRepo } from "./db/participants-repo.js";
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
import { workRouter } from "./api/work.js";
import { prsRouter } from "./api/prs.js";
import type { ProcessManager } from "./processes/manager.js";
import type { ProcessesRepo } from "./db/processes-repo.js";
import type { SkillsRepo } from "./db/skills-repo.js";
import type { RulesRepo } from "./db/rules-repo.js";
import type { DayReportsRepo } from "./db/day-reports-repo.js";
import type { PersonasRepo } from "./db/personas-repo.js";
import type { StatsRepo } from "./db/stats-repo.js";
import type { PrRecordsRepo } from "./db/pr-records-repo.js";
import type { SessionTaskRecordsRepo } from "./db/session-task-records-repo.js";
import type { TranscriptLogsRepo } from "./db/transcript-logs-repo.js";
import type {
  DiscordPendingQuestionsRepo,
  DiscordSessionChannelsRepo,
  DiscordConfigRepo,
} from "./db/discord-repo.js";
import type { AdminState } from "./admin/state.js";
import { ADMIN_PROPOSER_INTERVAL_MAX, ADMIN_PROPOSER_INTERVAL_MIN } from "./admin/state.js";
import type { SchedulerHandle } from "./daily/scheduler.js";
import { personasRouter } from "./api/personas.js";
import { slackAdminRouter, type SlackBotAdmin } from "./api/slack-admin.js";
import type { SlackConfigRepo } from "./db/slack-config-repo.js";
import type { SecretBox } from "./shared/secret-box.js";
import { spawnRouter } from "./api/spawn.js";
import { machinesRouter } from "./api/machines.js";
import { tasksRouter } from "./api/tasks.js";
import { delegationRouter } from "./api/delegation.js";
import type { DelegationRepo } from "./db/delegation-repo.js";
import type { DelegationService } from "./delegation/service.js";
import {
  isSpawnProvider,
  resolveSpawnCwd,
  spawnSession,
  SPAWN_PROVIDERS,
  type SpawnMode,
} from "./control/spawner.js";
import { stopSessionByLictorPid } from "./control/stop-session.js";
import { runSessionEndFlow } from "./control/end-session-flow.js";

export interface AppDeps {
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
  pendingQuestions: DiscordPendingQuestionsRepo;
  discordChannels: DiscordSessionChannelsRepo;
  discordConfig: DiscordConfigRepo;
  participants: ParticipantsRepo;
  delegation: DelegationRepo;
  delegationService: DelegationService;
  adminState: AdminState;
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
  discordAdmin?: {
    start: () => Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }>;
    stop: () => Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }>;
    restart: () => Promise<{ ok: boolean; status: "restarted" | "started" | "disabled" | "error"; error?: string }>;
  };
  // Slack をサービス内 (Web UI / API) から設定するための 3 点セット (揃った時のみ /v1/admin/slack を有効化)。
  slackConfig?: SlackConfigRepo;
  secretBox?: SecretBox;
  slackAdmin?: SlackBotAdmin;
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
      sessionTaskRecords: deps.sessionTaskRecords,
      transcriptLogs: deps.transcriptLogs,
      pendingQuestions: deps.pendingQuestions,
      discordChannels: deps.discordChannels,
      discordConfig: deps.discordConfig,
      participants: deps.participants,
    }),
  );
  app.route("/v1/tasks", tasksRouter({ records: deps.sessionTaskRecords }));
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
  app.route("/v1/prs", prsRouter({ prs: deps.prs }));
  app.route("/v1/work", workRouter({ sessions: deps.repo, transcriptLogs: deps.transcriptLogs, workspaceRoot: deps.config.workspaceRoot }));
  app.route(
    "/v1/daily-reports",
    dailyRouter({ dayReports: deps.dayReports, scheduler: deps.dailyScheduler }),
  );
  app.route("/v1/spawn", spawnRouter({ defaultSpawnCwd: deps.config.spawnDefaultCwd }));
  app.route("/v1/machines", machinesRouter({ repo: deps.repo }));
  app.route("/v1/delegation", delegationRouter({ repo: deps.delegation, service: deps.delegationService }));

  app.post("/v1/sweeper/run", (c) => {
    deps.sweeperRunOnce();
    return c.json({ ok: true });
  });

  // 管理 API: noise sessions の手動 truncate
  app.post("/v1/admin/truncate-sessions", (c) => {
    const n = deps.repo.truncateAllSessions();
    return c.json({ ok: true, deleted: n });
  });

  // 管理 API: lictor-wrapped セッションを新規 spawn する (Web UI / dashboard 用).
  // /v1/spawn と違って bearer token 不要 — Concordia の loopback 信頼境界に
  // 乗っかる (他の /v1/admin/* と同じ扱い). 同一プラットフォーム / 同一マシン
  // 用 — 他マシンへの spawn は将来 daemon-relay で扱う.
  app.post("/v1/admin/spawn-session", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const provider = (body.provider as string) ?? "claude";
    if (!isSpawnProvider(provider)) {
      return c.json(
        { error: `unknown provider: ${provider} (valid: ${SPAWN_PROVIDERS.join(", ")})` },
        400,
      );
    }
    const mode: SpawnMode = body.mode === "window" ? "window" : "tab";
    const result = spawnSession({
      provider,
      mode,
      args: Array.isArray(body.args)
        ? (body.args as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined,
      cwd: resolveSpawnCwd(body.cwd, deps.config.spawnDefaultCwd),
      title: typeof body.title === "string" ? body.title : undefined,
      env: isStringMap(body.env) ? (body.env as Record<string, string>) : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true, pid: result.pid, command: result.command });
  });

  // 管理 API: spawn の既定値を UI に晒す.
  // body.cwd を省略したときに実際に使われる path と、 platform_supported を返す.
  app.get("/v1/admin/spawn-defaults", (c) => {
    return c.json({
      default_cwd: deps.config.spawnDefaultCwd,
      platform_supported: process.platform === "win32",
    });
  });

  // 管理 API: 既存 lictor-wrapped セッションを kill.
  // 1. session row から metadata.lictor_pid を取得
  // 2. プラットフォーム別に process tree を kill (Win: taskkill /F /T, POSIX: SIGTERM)
  // 3. session を ended に遷移 + end event append (stopped_by: admin)
  // 4. session-end フロー (report 生成 / 独白を #報告 へ投稿 / persona release) を実行
  //    DELETE /v1/sessions/:id と同じ helper (control/end-session-flow.ts) を経由する.
  app.post("/v1/admin/stop-session/:id", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    if (!session.metadata) {
      return c.json({ error: "session has no metadata — was it lictor-wrapped?" }, 400);
    }
    let meta: { lictor_pid?: number };
    try {
      meta = JSON.parse(session.metadata) as { lictor_pid?: number };
    } catch {
      return c.json({ error: "session.metadata is not JSON" }, 400);
    }
    if (typeof meta.lictor_pid !== "number") {
      return c.json({ error: "session.metadata.lictor_pid missing" }, 400);
    }
    const killResult = stopSessionByLictorPid(meta.lictor_pid);
    if (!killResult.ok) return c.json({ error: killResult.error }, 500);
    const now = Math.floor(Date.now() / 1000);
    deps.repo.setStatus(id, "ended", now, now);
    deps.repo.appendEvent({
      session_id: id,
      ts: now,
      kind: "end",
      payload: { stopped_by: "admin", duration_sec: now - session.started_at },
    });
    const ended = deps.repo.findSession(id)!;
    const flow = await runSessionEndFlow(
      {
        repo: deps.repo,
        chat: deps.chat,
        dispatcher: deps.dispatcher,
        personas: deps.personas,
        config: deps.config,
      },
      ended,
    );
    return c.json({
      ok: true,
      pid: meta.lictor_pid,
      report_generated: flow.report !== null,
      monologue_posted: flow.postedMessageId !== null,
    });
  });

  // ── 管理 API: 3 つの runtime toggle ─────────────────────────────────
  // schema_meta 永続化 + AdminState 経由で dispatcher / rule engine / proposer
  // が次の tick から反映する. 再起動不要. Web UI (/rules ページ) からも操作可.

  app.get("/v1/admin/chat-mute", (c) => {
    return c.json({ muted: deps.adminState.getChatMuted() });
  });
  app.put("/v1/admin/chat-mute", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.muted !== "boolean") {
      return c.json({ error: "body.muted (boolean) required" }, 400);
    }
    deps.adminState.setChatMuted(body.muted);
    return c.json({ muted: deps.adminState.getChatMuted() });
  });

  app.get("/v1/admin/rules-enabled", (c) => {
    return c.json({ enabled: deps.adminState.getRulesEnabled() });
  });
  app.put("/v1/admin/rules-enabled", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled (boolean) required" }, 400);
    }
    deps.adminState.setRulesEnabled(body.enabled);
    return c.json({ enabled: deps.adminState.getRulesEnabled() });
  });

  app.get("/v1/admin/rule-proposer-interval", (c) => {
    return c.json({
      interval_sec: deps.adminState.getRuleProposerIntervalSec(),
      min_sec: ADMIN_PROPOSER_INTERVAL_MIN,
      max_sec: ADMIN_PROPOSER_INTERVAL_MAX,
    });
  });
  app.put("/v1/admin/rule-proposer-interval", async (c) => {
    const body = await c.req.json().catch(() => null);
    const n = Number(body?.interval_sec);
    if (!Number.isFinite(n)) {
      return c.json({ error: "body.interval_sec (number) required" }, 400);
    }
    try {
      deps.adminState.setRuleProposerIntervalSec(n);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ interval_sec: deps.adminState.getRuleProposerIntervalSec() });
  });

  app.get("/v1/admin/state", (c) => {
    return c.json({
      ...deps.adminState.snapshot(),
      proposer_interval_min_sec: ADMIN_PROPOSER_INTERVAL_MIN,
      proposer_interval_max_sec: ADMIN_PROPOSER_INTERVAL_MAX,
    });
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

  app.post("/v1/admin/discord/start", async (c) => {
    if (!deps.discordAdmin) return c.json({ ok: false, error: "discord_admin_not_ready" }, 503);
    const r = await deps.discordAdmin.start();
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/v1/admin/discord/stop", async (c) => {
    if (!deps.discordAdmin) return c.json({ ok: false, error: "discord_admin_not_ready" }, 503);
    const r = await deps.discordAdmin.stop();
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/v1/admin/discord/restart", async (c) => {
    if (!deps.discordAdmin) return c.json({ ok: false, error: "discord_admin_not_ready" }, 503);
    const r = await deps.discordAdmin.restart();
    return c.json(r, r.ok ? 200 : 500);
  });

  // Slack をサービス内から設定 (config GET/PUT + start/stop/restart)。3 点セットが揃った時のみ有効。
  if (deps.slackConfig && deps.secretBox && deps.slackAdmin) {
    app.route(
      "/v1/admin/slack",
      slackAdminRouter({ config: deps.slackConfig, secretBox: deps.secretBox, admin: deps.slackAdmin }),
    );
  }

  return app;
}

function isStringMap(x: unknown): x is Record<string, string> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  for (const v of Object.values(x as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}
