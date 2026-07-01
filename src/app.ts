/**
 * Hono app factory.
 */

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionsRepo } from "./db/sessions-repo.js";
import type { ParticipantsRepo } from "./db/participants-repo.js";
import type { TasksRepo } from "./db/tasks-repo.js";
import type { ChatRepo } from "./db/chat-repo.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ConcordiaConfig } from "./shared/config.js";
import { sessionsRouter } from "./api/sessions.js";
import { reportsRouter } from "./api/reports.js";
import { sessionLogsRouter } from "./api/session-logs.js";
import { monitorRouter } from "./api/monitor.js";
import { chatRouter } from "./api/chat.js";
import { setupRouter } from "./api/setup.js";
import { skillsRouter } from "./api/skills.js";
import { streamRouter } from "./api/stream.js";
import { rulesRouter } from "./api/rules.js";
import { libraryRouter } from "./api/library.js";
import { dailyRouter } from "./api/daily.js";
import { processesRouter } from "./api/processes.js";
import { statRouter } from "./api/stat.js";
import { workRouter } from "./api/work.js";
import { prsRouter } from "./api/prs.js";
import { costFeedRouter } from "./api/cost-feed.js";
import { costRouter } from "./api/cost.js";
import type { CostUsageSamplesRepo } from "./db/cost-usage-samples-repo.js";
import type { CostOneShotCallsRepo } from "./db/cost-one-shot-calls-repo.js";
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
import { adminAuthMiddleware } from "./shared/admin-auth.js";
import type { CostBudgetStatus } from "./cost/usage-tracker.js";
import { getRwf } from "./platform/reaction-workflow-loader.js";
import type { SchedulerHandle } from "./daily/scheduler.js";
import { personasRouter } from "./api/personas.js";
import { slackAdminRouter, type SlackBotAdmin } from "./api/slack-admin.js";
import type { SlackConfigRepo } from "./db/slack-config-repo.js";
import type { SecretBox } from "./shared/secret-box.js";
import { setDiscordConfig, discordConfigStatus } from "./discord/conn-config.js";
import { z } from "zod";
import { spawnRouter } from "./api/spawn.js";
import { machinesRouter } from "./api/machines.js";
import { tasksRouter } from "./api/tasks.js";
import { delegationRouter } from "./api/delegation.js";
import type { DelegationRepo } from "./db/delegation-repo.js";
import type { DelegationService } from "./delegation/service.js";
import { substituteVars } from "./delegation/service.js";
import { recordPendingDelegationSpawn } from "./control/pending-delegation-spawns.js";
import { modelCatalogRouter } from "./api/model-catalog.js";
import { subsidiaryRouter } from "./api/subsidiary.js";
import { createChildLogger } from "./shared/logger.js";
import { harnessRulesRouter } from "./api/harness-rules.js";
import { harnessSessionRouter } from "./api/harness-session.js";
import type { HarnessAuditRepo } from "./db/harness-audit-repo.js";
import type { RunClaudeFn } from "./subsidiary/guard.js";
import type { SubsidiaryRepo } from "./db/subsidiary-repo.js";
import type { SubsidiaryBudgetTracker } from "./subsidiary/budget.js";
import type { HarnessRulesRepo } from "./db/harness-rules-repo.js";
import type { SubsidiaryBotManager } from "./subsidiary/manager.js";
import type { ModelCatalogRepo } from "./db/model-catalog-repo.js";
import {
  isSpawnProvider,
  resolveSpawnCwd,
  spawnSession,
  SPAWN_PROVIDERS,
  type SpawnMode,
} from "./control/spawner.js";
import { resolveDelegationSpawn } from "./control/provider-preset.js";
import { resolveLocalModel } from "./control/famulus-select.js";
import { basename } from "node:path";
import { stopSessionByLictorPid } from "./control/stop-session.js";
import { reapOrphans } from "./control/reaper.js";
import { runWsCleanup } from "./control/ws-cleanup.js";
import type { MetricsStore } from "./metrics/store.js";
import { runSessionEndFlow } from "./control/end-session-flow.js";

export interface AppDeps {
  repo: SessionsRepo;
  /** PC パフォーマンススナップショットの読み出し (Monitor /metrics 用)。 */
  metrics?: MetricsStore;
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
  /** 10 分毎の使用量サンプル (WebUI /cost の時系列グラフ用)。 */
  costSamples: CostUsageSamplesRepo;
  costOneShots: CostOneShotCallsRepo;
  participants: ParticipantsRepo;
  delegation: DelegationRepo;
  delegationService: DelegationService;
  modelCatalog: ModelCatalogRepo;
  /** 子会社 Delegation。 揃った時のみ /v1/subsidiaries / /v1/harness-rules を有効化。 */
  subsidiary?: SubsidiaryRepo;
  harnessRules?: HarnessRulesRepo;
  /** ローカルセッションのハーネス強制ゲートの監査ログ。 揃った時のみ /v1/harness を有効化。 */
  harnessAudit?: HarnessAuditRepo;
  /** per-prompt 意図判定 (POST /v1/harness/intent) 用の Sonnet runner。 未指定なら /intent は無効 (opt-in)。 */
  harnessRunClaude?: RunClaudeFn;
  subsidiaryManager?: SubsidiaryBotManager;
  /** 子会社の日次トークン予算トラッカー (ダッシュボードに当日消費を表示)。 */
  subsidiaryBudget?: SubsidiaryBudgetTracker;
  adminState: AdminState;
  /** コスト予算の現況 (当日消費 / 予算 / block 判定)。 spawn ブロック + 設定 GUI 表示用。 */
  costStatus?: () => CostBudgetStatus;
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

  // 信頼境界: admin / sweeper エンドポイントは loopback 前提で無認証だが、
  // CONCORDIA_ADMIN_TOKEN を設定すると bearer 認証を要求する (非 loopback bind 時は
  // server.ts が token 必須を強制)。 token は config から live 解決。
  const adminAuth = adminAuthMiddleware(() => deps.config.adminToken);
  app.use("/v1/admin/*", adminAuth);
  app.use("/v1/sweeper/run", adminAuth);

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
      resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots(),
      harnessAudit: deps.harnessAudit,
    }),
  );
  app.route("/v1/tasks", tasksRouter({ records: deps.sessionTaskRecords }));
  app.route("/v1/processes", processesRouter({ manager: deps.processManager, repo: deps.processes }));
  app.route(
    "/v1/personas",
    personasRouter({ personas: deps.personas, sessions: deps.repo, chat: deps.chat, config: deps.config }),
  );
  app.route("/v1/reports", reportsRouter({ repo: deps.repo, config: deps.config }));
  app.route(
    "/v1/session-logs",
    sessionLogsRouter({ resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }),
  );
  app.route("/v1/monitor", monitorRouter({ repo: deps.repo, metrics: deps.metrics }));
  app.route("/v1/chat", chatRouter({ chat: deps.chat, dispatcher: deps.dispatcher }));
  app.route("/v1/setup", setupRouter({ toolPath: deps.toolPath, url: deps.publicUrl }));
  app.route("/v1/skills", skillsRouter({ skills: deps.skills }));
  app.route("/v1/stream", streamRouter());
  app.route("/v1/rules", rulesRouter({ rules: deps.rules }));
  app.route(
    "/v1/library",
    libraryRouter({ resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }),
  );
  app.route("/v1/stat", statRouter({ stats: deps.stats, sessions: deps.repo }));
  app.route("/v1/prs", prsRouter({ prs: deps.prs }));
  app.route("/v1/work", workRouter({ sessions: deps.repo, transcriptLogs: deps.transcriptLogs, resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }));
  app.route(
    "/v1/daily-reports",
    dailyRouter({ dayReports: deps.dayReports, scheduler: deps.dailyScheduler }),
  );
  app.route(
    "/v1/spawn",
    spawnRouter({
      // 既定 cwd は env 固定の spawnDefaultCwd ではなくプライマリ workspace ルート
      // (実行時解決) を採用する。 設定 GUI での workspace root 変更が即反映される。
      resolveDefaultCwd: () => deps.adminState.getWorkspaceRoot(),
      isCostBlocked: () => deps.costStatus?.().blocked ?? false,
    }),
  );
  app.route("/v1/machines", machinesRouter({ repo: deps.repo }));
  app.route("/v1/delegation", delegationRouter({ repo: deps.delegation, service: deps.delegationService }));
  app.route("/v1/model-catalog", modelCatalogRouter({ repo: deps.modelCatalog }));
  if (deps.harnessRules) {
    app.route("/v1/harness-rules", harnessRulesRouter({ repo: deps.harnessRules }));
  }
  if (deps.harnessAudit && deps.harnessRules) {
    app.route(
      "/v1/harness",
      harnessSessionRouter({ audit: deps.harnessAudit, rules: deps.harnessRules, runClaude: deps.harnessRunClaude }),
    );
  }
  if (deps.subsidiary && deps.subsidiaryManager && deps.secretBox) {
    app.route(
      "/v1/subsidiaries",
      subsidiaryRouter({ repo: deps.subsidiary, delegationRepo: deps.delegation, manager: deps.subsidiaryManager, secretBox: deps.secretBox, budget: deps.subsidiaryBudget, runClaude: deps.harnessRunClaude, log: createChildLogger("subsidiary-api") }),
    );
  }
  // クロスサービス cost-feed (Anatomia の同名パネルを複製。送信元は両方へ push しうる)。
  // env 解決の singleton を使うので AppDeps への配線は不要。
  app.route("/v1/cost-feed", costFeedRouter());
  app.route(
    "/v1/cost",
    costRouter({
      sessions: deps.repo,
      channels: deps.discordChannels,
      samples: deps.costSamples,
      oneShots: deps.costOneShots,
      listSubsidiaries: () =>
        deps.subsidiary
          ? deps.subsidiary
              .list()
              .map((s) => ({ id: s.id, name: s.display_name || s.name, daily_token_budget: s.daily_token_budget }))
          : [],
    }),
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
    const mode: SpawnMode = body.mode === "window" ? "window" : "tab";
    // 子会社 Bot 由来の spawn は subsidiary_id を引き継ぎ、 spawn したセッションに焼く
    // (session.started 時に cwd で claim → metadata.subsidiary_id)。 これが無いと
    // 未タグ = 本社所有扱いになり、 自動生成された session チャンネルが本社側に出てしまう。
    const subsidiaryId = typeof body.subsidiary_id === "string" && body.subsidiary_id.trim() ? body.subsidiary_id.trim() : null;

    // ── template 起動経路 ─────────────────────────────────────
    // body.template (call_name) があれば delegation テンプレから起動する。
    //   - provider / model / 既定 cwd はテンプレから採用。
    //   - body.inject_prompt=true なら prompt を render して自動注入 (= delegation
    //     invoke と同じ実体)。 false (既定) なら provider+model だけの素のセッション。
    // loopback 信頼境界に乗るため bearer token は不要 (他 /v1/admin/* と同様)。
    const templateName = typeof body.template === "string" ? body.template.trim() : "";
    if (templateName) {
      const tpl = deps.delegation.findTemplateByCallName(templateName);
      if (!tpl) return c.json({ error: `unknown template: ${templateName}` }, 404);
      if (!tpl.is_active) return c.json({ error: `template inactive: ${templateName}` }, 400);
      const injectPrompt = body.inject_prompt === true;
      const tplArgs = isPlainObject(body.args) ? (body.args as Record<string, unknown>) : {};
      const cwdOverride = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined;

      if (injectPrompt) {
        // prompt 注入あり = delegation invoke 本体に委譲 (render + prompt file + env + run 記録 + --model)。
        const result = await deps.delegationService.invoke({
          call_name: tpl.call_name,
          args: tplArgs,
          cwd: cwdOverride,
          triggered_by: "web-spawn",
          spawn: true,
          subsidiary_id: subsidiaryId,
        });
        if (!result.ok) return c.json({ error: result.error, detail: result.details }, 400);
        return c.json({
          ok: true,
          pid: result.spawn_pid,
          command: result.spawn_command,
          run_id: result.run.id,
          injected_prompt: true,
        });
      }

      // prompt 注入なし = provider + model だけ採用した素のセッション。
      // cwd: caller override → テンプレ default_cwd の `${var}` を args で展開 (auto-model の
      // ヒント用に resolveDelegationSpawn より先に解決)。展開後が空 / 未解決 (`${` 残存) なら
      // undefined にして spawnDefaultCwd に委ねる。
      let tplCwd: string | undefined = cwdOverride;
      if (!tplCwd && tpl.default_cwd) {
        const expanded = substituteVars(tpl.default_cwd, tplArgs).trim();
        tplCwd = (expanded && !expanded.includes("${")) ? expanded : undefined;
      }
      // local-LLM レーンで model="auto" なら Famulus 黒箱に選ばせる (delegation invoke と同じ。
      // 選択 Sonnet は Famulus 内部 = Concordia は LLM-free)。それ以外は素通し。
      let modelInput = tpl.model;
      if (tpl.target_provider === "gemma4-12" && (tpl.model ?? "").trim().toLowerCase() === "auto") {
        modelInput = await resolveLocalModel(tpl.model, { project: tplCwd ? basename(tplCwd) : undefined, repo: tplCwd ?? null });
      }
      // 論理 provider (gemma4-12 等) → 実 spawn に解決 (delegation invoke と同じ写像)。
      const spawn = resolveDelegationSpawn(tpl.target_provider, modelInput);
      const spawnCwd = resolveSpawnCwd(tplCwd, deps.adminState.getWorkspaceRoot());
      const result = spawnSession({
        provider: spawn.provider,
        mode,
        args: spawn.args.length > 0 ? spawn.args : undefined,
        cwd: spawnCwd,
        title: `tpl:${tpl.call_name}`,
        // gemma4-12 の LICTOR_LOCAL_MODEL 等、 spawn 解決由来の env を渡す。
        env: spawn.env,
      });
      if (!result.ok) return c.json({ error: result.error }, 400);
      // delegation_emoji を pending registry に登録。session.started 受信時に cwd で claim して metadata に焼く。
      recordPendingDelegationSpawn({ cwd: spawnCwd, emoji: tpl.emoji ?? null, callName: tpl.call_name, subsidiaryId });
      return c.json({ ok: true, pid: result.pid, command: result.command, injected_prompt: false });
    }

    // ── 従来経路: provider 直接指定 ───────────────────────────
    const provider = (body.provider as string) ?? "claude";
    if (!isSpawnProvider(provider)) {
      return c.json(
        { error: `unknown provider: ${provider} (valid: ${SPAWN_PROVIDERS.join(", ")})` },
        400,
      );
    }
    // model 指定 → resolveDelegationSpawn で `--model` 引数 / LICTOR_LOCAL_MODEL env に解決。
    const modelInput = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const resolved = resolveDelegationSpawn(provider, modelInput);
    const userArgs = Array.isArray(body.args)
      ? (body.args as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    // prompt (自由テキスト初回指示) があれば prompt file に書き、 Lictor 注入用 env を内部設定する。
    // env 値は Concordia が生成するファイルパスのみ (外部から任意 env は受け取らない = CWE-78 対策)。
    const adHocPrompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : "";
    const spawnEnv: Record<string, string> = { ...resolved.env };
    if (adHocPrompt) {
      spawnEnv.CONCORDIA_DELEGATION_PROMPT_FILE = deps.delegationService.writeAdHocPrompt(adHocPrompt);
    }
    const directCwd = resolveSpawnCwd(body.cwd, deps.adminState.getWorkspaceRoot());
    const result = spawnSession({
      provider: resolved.provider,
      mode,
      args: [...resolved.args, ...userArgs],
      cwd: directCwd,
      title: typeof body.title === "string" ? body.title : undefined,
      env: Object.keys(spawnEnv).length > 0 ? spawnEnv : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    // 子会社由来の素の provider spawn も subsidiary_id を焼く (本社流入防止)。 本社の通常
    // spawn では pending を積まない (cwd 衝突で他 delegation の claim を奪わないため)。
    if (subsidiaryId) {
      recordPendingDelegationSpawn({ cwd: directCwd, callName: "spawn", subsidiaryId });
    }
    return c.json({ ok: true, pid: result.pid, command: result.command, injected_prompt: !!adHocPrompt });
  });

  // 管理 API: spawn の既定値を UI に晒す.
  // body.cwd を省略したときに実際に使われる path と、 platform_supported を返す.
  app.get("/v1/admin/spawn-defaults", (c) => {
    return c.json({
      // 実際に spawn で使われる既定 cwd = プライマリ workspace ルート (実行時解決)。
      default_cwd: deps.adminState.getWorkspaceRoot(),
      platform_supported: process.platform === "win32",
    });
  });

  // 管理 API: 既存 lictor-wrapped セッションを kill.
  // 1. session row から metadata.lictor_pid を取得
  // 2. session を ended に遷移 + end event append (stopped_by: admin)
  // 3. session-end フロー (report 生成 / 独白を #報告 へ投稿 / persona release) を実行
  // 4. 独白後に platform 別 process tree を kill (Win: taskkill /F /T, POSIX: SIGTERM)
  //    DELETE /v1/sessions/:id と同じ helper (control/end-session-flow.ts) を経由する.
  app.post("/v1/admin/stop-session/:id", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    if (!session.metadata) {
      return c.json({ error: "session has no metadata — was it lictor-wrapped?" }, 400);
    }
    let meta: { lictor_pid?: number; agent_client_pid?: number };
    try {
      meta = JSON.parse(session.metadata) as { lictor_pid?: number; agent_client_pid?: number };
    } catch {
      return c.json({ error: "session.metadata is not JSON" }, 400);
    }
    if (typeof meta.lictor_pid !== "number") {
      return c.json({ error: "session.metadata.lictor_pid missing" }, 400);
    }
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
        harnessAudit: deps.harnessAudit,
      },
      ended,
    );
    const killResult = stopSessionByLictorPid(meta.lictor_pid);
    // agent-client (別ツリー) も登録 pid があれば落とす (best-effort)。
    if (typeof meta.agent_client_pid === "number") {
      stopSessionByLictorPid(meta.agent_client_pid);
    }
    if (!killResult.ok) {
      return c.json({
        ok: false,
        error: killResult.error,
        pid: meta.lictor_pid,
        report_generated: flow.report !== null,
        monologue_posted: flow.postedMessageId !== null,
      }, 500);
    }
    return c.json({
      ok: true,
      pid: meta.lictor_pid,
      agent_client_pid: meta.agent_client_pid ?? null,
      report_generated: flow.report !== null,
      monologue_posted: flow.postedMessageId !== null,
    });
  });

  // ── 管理 API: 孤児プロセス回収 (reaper) ─────────────────────────────
  // GET  /v1/admin/orphans : dry-run。 終了/消滅 session に紐付かない Lictor/agent-client の一覧。
  // POST /v1/admin/reap    : 回収実行 (kill)。 body {dry_run?: boolean, min_age_sec?: number}。
  app.get("/v1/admin/orphans", async (c) => {
    const r = await reapOrphans({ repo: deps.repo }, {
      dryRun: true,
      minAgeSec: deps.config.reaperMinAgeSec,
      endedGraceSec: deps.config.reaperEndedGraceSec,
    });
    return c.json({ scanned: r.scanned, orphans: r.orphans });
  });
  app.post("/v1/admin/reap", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { dry_run?: boolean; min_age_sec?: number };
    const minAgeSec =
      typeof body.min_age_sec === "number" && body.min_age_sec >= 0
        ? body.min_age_sec
        : deps.config.reaperMinAgeSec;
    const r = await reapOrphans(
      { repo: deps.repo },
      { dryRun: body.dry_run === true, minAgeSec, endedGraceSec: deps.config.reaperEndedGraceSec },
    );
    return c.json({
      scanned: r.scanned,
      orphans: r.orphans.length,
      killed: r.killed.length,
      failed: r.failed.length,
      detail: r,
    });
  });

  // ── 管理 API: ワークスペース整理 (ws-cleanup) ───────────────────────
  // GET  /v1/admin/ws-cleanup : dry-run。 各リポの worktree prune / main ff 更新 /
  //   マージ済みブランチ削除の「予定」と、 ユーザ判断に委ねる保留事項を出す (無変更)。
  // POST /v1/admin/ws-cleanup : 実行。 body {apply?: boolean(既定 true), fetch?: boolean,
  //   delete_merged_remote_gone?: boolean}。 安全アクションのみ自動、 未マージ/作業中は保留出力。
  app.get("/v1/admin/ws-cleanup", async (c) => {
    const r = await runWsCleanup(deps.adminState.getWorkspaceRoots(), deps.repo, { apply: false });
    return c.json(r);
  });
  app.post("/v1/admin/ws-cleanup", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      apply?: boolean;
      fetch?: boolean;
      delete_merged_remote_gone?: boolean;
    };
    const r = await runWsCleanup(deps.adminState.getWorkspaceRoots(), deps.repo, {
      apply: body.apply !== false,
      fetch: body.fetch !== false,
      deleteMergedRemoteGone: body.delete_merged_remote_gone !== false,
    });
    return c.json(r);
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

  // ワークスペースルート / GitHub Organization (schema_meta 永続化、 設定 GUI から編集)。
  // 変更は次の Discord/Slack bot start (= restart) で実効値として反映される。
  app.get("/v1/admin/workspace-root", (c) => {
    return c.json({ workspace_root: deps.adminState.getWorkspaceRoot() });
  });
  app.put("/v1/admin/workspace-root", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.workspace_root !== "string") {
      return c.json({ error: "body.workspace_root (string) required" }, 400);
    }
    deps.adminState.setWorkspaceRoot(body.workspace_root);
    return c.json({ workspace_root: deps.adminState.getWorkspaceRoot() });
  });

  // 複数ワークスペースルート (走査対象の全ルート)。 先頭がプライマリ。
  app.get("/v1/admin/workspace-roots", (c) => {
    return c.json({ workspace_roots: deps.adminState.getWorkspaceRoots() });
  });
  app.put("/v1/admin/workspace-roots", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.workspace_roots) || body.workspace_roots.some((v: unknown) => typeof v !== "string")) {
      return c.json({ error: "body.workspace_roots (string[]) required" }, 400);
    }
    deps.adminState.setWorkspaceRoots(body.workspace_roots as string[]);
    return c.json({ workspace_roots: deps.adminState.getWorkspaceRoots() });
  });

  // コスト予算 (日次トークン上限)。 0 = 無効。 当日消費 / block 判定も併せて返す。
  app.get("/v1/admin/cost-budget", (c) => {
    const status = deps.costStatus?.() ?? null;
    return c.json({
      daily_token_budget: deps.adminState.getDailyTokenBudget(),
      today_tokens: status?.todayTokens ?? 0,
      blocked: status?.blocked ?? false,
      date_iso: status?.dateIso ?? null,
    });
  });
  app.put("/v1/admin/cost-budget", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.daily_token_budget !== "number" || !Number.isFinite(body.daily_token_budget)) {
      return c.json({ error: "body.daily_token_budget (number, 0=disabled) required" }, 400);
    }
    deps.adminState.setDailyTokenBudget(body.daily_token_budget);
    const status = deps.costStatus?.() ?? null;
    return c.json({
      daily_token_budget: deps.adminState.getDailyTokenBudget(),
      today_tokens: status?.todayTokens ?? 0,
      blocked: status?.blocked ?? false,
    });
  });

  app.get("/v1/admin/github-org", (c) => {
    return c.json({ github_org: deps.adminState.getGithubOrg() });
  });
  app.put("/v1/admin/github-org", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.github_org !== "string") {
      return c.json({ error: "body.github_org (string) required" }, 400);
    }
    deps.adminState.setGithubOrg(body.github_org);
    return c.json({ github_org: deps.adminState.getGithubOrg() });
  });

  // リアクションワークフロー安全弁 (ON/OFF)。 runner が毎回 live 評価するので即時反映。
  app.get("/v1/admin/reaction-workflow", (c) => {
    return c.json({ enabled: deps.adminState.getReactionWorkflowEnabled() });
  });
  app.put("/v1/admin/reaction-workflow", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled (boolean) required" }, 400);
    }
    deps.adminState.setReactionWorkflowEnabled(body.enabled);
    return c.json({ enabled: deps.adminState.getReactionWorkflowEnabled() });
  });

  // 絵文字→アクション 写像: 既定 + ユーザ上書き。 上書きは schema_meta 永続化で即時反映。
  app.get("/v1/admin/reaction-mappings", (c) => {
    const rwf = getRwf();
    const defaults = rwf.defaultReactionEmojiMap();
    const overrides = deps.adminState.getReactionEmojiOverrides();
    // action_help: 各カスタムコマンド (ワークフロー) が何をするかのヘルプ (GUI 表示用)。
    return c.json({ defaults, overrides, actions: rwf.WORKFLOW_ACTIONS, action_help: rwf.WORKFLOW_ACTION_HELP });
  });
  app.put("/v1/admin/reaction-mappings", async (c) => {
    const body = await c.req.json().catch(() => null);
    const emoji = typeof body?.emoji === "string" ? body.emoji.trim() : "";
    const action = typeof body?.action === "string" ? body.action : "";
    if (!emoji) return c.json({ error: "body.emoji (string) required" }, 400);
    if (!getRwf().isWorkflowAction(action)) {
      return c.json({ error: `body.action must be one of ${getRwf().WORKFLOW_ACTIONS.join(", ")}` }, 400);
    }
    deps.adminState.setReactionEmojiOverride(emoji, action);
    return c.json({ overrides: deps.adminState.getReactionEmojiOverrides() });
  });
  app.delete("/v1/admin/reaction-mappings/:emoji", (c) => {
    deps.adminState.deleteReactionEmojiOverride(decodeURIComponent(c.req.param("emoji")));
    return c.json({ overrides: deps.adminState.getReactionEmojiOverrides() });
  });

  // Lictor 起動設定 (mode + dev/prod パス)。 spawn の launcher 解決に使う。 即時反映。
  app.get("/v1/admin/lictor", (c) => {
    return c.json({
      lictor_mode: deps.adminState.getLictorMode(),
      lictor_dev_path: deps.adminState.getLictorDevPath(),
      lictor_prod_exe: deps.adminState.getLictorProdExe(),
    });
  });
  app.put("/v1/admin/lictor", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "json body required" }, 400);
    try {
      if (typeof body.lictor_mode === "string") deps.adminState.setLictorMode(body.lictor_mode);
      if (typeof body.lictor_dev_path === "string") deps.adminState.setLictorDevPath(body.lictor_dev_path);
      if (typeof body.lictor_prod_exe === "string") deps.adminState.setLictorProdExe(body.lictor_prod_exe);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({
      lictor_mode: deps.adminState.getLictorMode(),
      lictor_dev_path: deps.adminState.getLictorDevPath(),
      lictor_prod_exe: deps.adminState.getLictorProdExe(),
    });
  });

  app.get("/v1/admin/state", (c) => {
    return c.json(deps.adminState.snapshot());
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
      // shell:true を避けてアタック面を減らす (CWE-78)。 固定コマンドだが OS shell を
      // 介さず、 Windows では npm.cmd を明示して直接 spawn する。
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npmCmd, ["run", "dev:backend"], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
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

  // Discord 接続設定をサービス内 (Web UI / API) から設定する (Slack /config と対の構成)。
  //  - GET  /config : redact 済み設定状態 (token 値は返さない)
  //  - PUT  /config : 設定更新 (token は暗号化保存) → bot を hot 再接続
  if (deps.discordConfig && deps.secretBox && deps.discordAdmin) {
    const discordConfig = deps.discordConfig;
    const secretBox = deps.secretBox;
    const discordAdmin = deps.discordAdmin;
    const DiscordPutSchema = z.object({
      enabled: z.boolean().optional(),
      // null / 空文字 = クリア (env フォールバックに戻す)、 文字列 = 設定
      guild_id: z.string().max(64).nullable().optional(),
      application_id: z.string().max(64).nullable().optional(),
      token: z.string().max(256).nullable().optional(),
    });

    app.get("/v1/admin/discord/config", (c) =>
      c.json(discordConfigStatus(discordConfig, secretBox)),
    );

    app.put("/v1/admin/discord/config", async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = DiscordPutSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
      setDiscordConfig(discordConfig, secretBox, {
        enabled: parsed.data.enabled,
        guildId: parsed.data.guild_id,
        applicationId: parsed.data.application_id,
        token: parsed.data.token,
      });
      const restart = await discordAdmin.restart();
      return c.json({
        ok: restart.ok,
        status: discordConfigStatus(discordConfig, secretBox),
        restart,
      });
    });
  }

  // Slack をサービス内から設定 (config GET/PUT + start/stop/restart)。3 点セットが揃った時のみ有効。
  if (deps.slackConfig && deps.secretBox && deps.slackAdmin) {
    app.route(
      "/v1/admin/slack",
      slackAdminRouter({ config: deps.slackConfig, secretBox: deps.secretBox, admin: deps.slackAdmin }),
    );
  }

  // Web allowedHosts 設定 (concordia.config.json の web.allowedHosts を読み書き)。
  // Vite dev server 再起動で反映される。
  const webConfigPath = resolve(process.cwd(), "concordia.config.json");

  function readWebHosts(): string[] {
    if (!existsSync(webConfigPath)) return [];
    try {
      const cfg = JSON.parse(readFileSync(webConfigPath, "utf8")) as { web?: { allowedHosts?: unknown } };
      const hosts = cfg?.web?.allowedHosts;
      return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
    } catch { return []; }
  }

  function writeWebHosts(hosts: string[]): void {
    let cfg: Record<string, unknown> = {};
    if (existsSync(webConfigPath)) {
      try { cfg = JSON.parse(readFileSync(webConfigPath, "utf8")) as Record<string, unknown>; } catch { /* ignore */ }
    }
    const web = (cfg.web && typeof cfg.web === "object" && !Array.isArray(cfg.web))
      ? { ...(cfg.web as Record<string, unknown>) }
      : {} as Record<string, unknown>;
    web.allowedHosts = hosts;
    cfg.web = web;
    writeFileSync(webConfigPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  app.get("/v1/admin/web-hosts", (c) => c.json({ allowed_hosts: readWebHosts() }));

  app.put("/v1/admin/web-hosts", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.allowed_hosts)) {
      return c.json({ error: "body.allowed_hosts (string[]) required" }, 400);
    }
    const hosts = (body.allowed_hosts as unknown[]).filter((h): h is string => typeof h === "string");
    writeWebHosts(hosts);
    return c.json({ allowed_hosts: readWebHosts(), note: "Vite dev server の再起動後に反映されます" });
  });

  // ─── Web UI 配信 (built SPA) ────────────────────────────────────────────
  // backend port (11111) の root を 404 にしない。 ビルド済み web UI (web/dist) を
  // 配信し、 Excubitor / Tunnel から :11111 を開いても UI が出るようにする
  // (tier: personal の Memoria local と同様、 server 単一 port で UI を提供する)。
  // API (/v1, /health) は上で解決済みなので干渉しない。 dev で UI を hot-reload したい
  // 場合は従来どおり Vite (10101) を直接開く。
  const webDistRoot = "./web/dist";
  const webIndexPath = resolve(process.cwd(), "web/dist/index.html");
  if (existsSync(webIndexPath)) {
    const indexHtml = readFileSync(webIndexPath, "utf8");
    // 実ファイル (index.html / assets / favicon 等) を配信。
    app.use("/*", serveStatic({ root: webDistRoot }));
    // SPA フォールバック: ファイルが無いパス (クライアントルート) は index.html を返す。
    // ただし API 名前空間は HTML を返さず 404 のままにする。
    app.get("*", (c) => {
      const p = c.req.path;
      if (p.startsWith("/v1") || p === "/health") return c.notFound();
      return c.html(indexHtml);
    });
  }

  return app;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
