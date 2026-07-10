import type { Hono } from "hono";
import { spawn } from "node:child_process";
import { existsSync, utimesSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ParticipantsRepo } from "../db/participants-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import { sessionsRouter } from "./sessions.js";
import { reportsRouter } from "./reports.js";
import { sessionLogsRouter } from "./session-logs.js";
import { setupRouter } from "./setup.js";
import { skillsRouter } from "./skills.js";
import { rulesRouter } from "./rules.js";
import { libraryRouter } from "./library.js";
import { processesRouter } from "./processes.js";
import { statRouter } from "./stat.js";
import { workRouter } from "./work.js";
import { prsRouter } from "./prs.js";
import type { ProcessManager } from "../processes/manager.js";
import type { ProcessesRepo } from "../db/processes-repo.js";
import type { SkillsRepo } from "../db/skills-repo.js";
import type { RulesRepo } from "../db/rules-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { StatsRepo } from "../db/stats-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import type { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import type {
  DiscordPendingQuestionsRepo,
  DiscordSessionChannelsRepo,
  DiscordConfigRepo,
} from "../db/discord-repo.js";
import type { AdminState } from "../admin/state.js";
import type { CostBudgetStatus } from "../cost/usage-tracker.js";
import { personasRouter } from "./personas.js";
import type { SecretBox } from "../shared/secret-box.js";
import type { ChannelDirectory } from "./sessions/deps.js";
import { spawnRouter } from "./spawn.js";
import { machinesRouter } from "./machines.js";
import { tasksRouter } from "./tasks.js";
import { delegationRouter } from "./delegation.js";
import { parseRuntimeOptions, type DelegationRepo } from "../db/delegation-repo.js";
import type { DelegationService } from "../delegation/service.js";
import { substituteVars } from "../delegation/service.js";
import { recordPendingDelegationSpawn } from "../control/pending-delegation-spawns.js";
import { modelCatalogRouter } from "./model-catalog.js";
import { subsidiaryRouter } from "./subsidiary.js";
import { createChildLogger } from "../shared/logger.js";
import { harnessRulesRouter } from "./harness-rules.js";
import { harnessSessionRouter } from "./harness-session.js";
import { testingRouter } from "./testing.js";
import type { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import type { HarnessBlackboxService } from "../harness/blackbox-engine.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import type { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import type { SubsidiaryBudgetTracker } from "../subsidiary/budget.js";
import type { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import type { SubsidiaryBotManager } from "../subsidiary/manager.js";
import type { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import {
  isSpawnProvider,
  resolveAgentHomeCwd,
  resolveCastraDefaultCwd,
  resolveSpawnCwd,
  spawnSession,
  SPAWN_PROVIDERS,
  type SpawnMode,
} from "../control/spawner.js";
import { prepareSpawnTarget } from "../control/spawn-target.js";
import { resolveDelegationRuntimeArgs, resolveDelegationSpawn } from "../control/provider-preset.js";
import { resolveLocalModel } from "../control/famulus-select.js";
import { basename } from "node:path";
import { stopSessionByLictorPid } from "../control/stop-session.js";
import { reapOrphans } from "../control/reaper.js";
import { runWsCleanup } from "../control/ws-cleanup.js";
import { runSessionEndFlow } from "../control/end-session-flow.js";

export interface CoreDeps {
  repo: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  skills: SkillsRepo;
  rules: RulesRepo;
  personas: PersonasRepo;
  processes: ProcessesRepo;
  stats: StatsRepo;
  prs: PrRecordsRepo;
  sessionTaskRecords: SessionTaskRecordsRepo;
  transcriptLogs: TranscriptLogsRepo;
  pendingQuestions: DiscordPendingQuestionsRepo;
  discordChannels: DiscordSessionChannelsRepo;
  discordConfig: DiscordConfigRepo;
  channelDirectory: ChannelDirectory;
  participants: ParticipantsRepo;
  delegation: DelegationRepo;
  delegationService: DelegationService;
  modelCatalog: ModelCatalogRepo;
  testingClaims?: import("../db/testing-claims-repo.js").TestingClaimsRepo;
  subsidiary?: SubsidiaryRepo;
  harnessRules?: HarnessRulesRepo;
  harnessAudit?: HarnessAuditRepo;
  harnessRunClaude?: RunClaudeFn;
  harnessBlackbox?: HarnessBlackboxService;
  subsidiaryManager?: SubsidiaryBotManager;
  subsidiaryBudget?: SubsidiaryBudgetTracker;
  adminState: AdminState;
  costStatus?: () => CostBudgetStatus;
  processManager: ProcessManager;
  config: ConcordiaConfig;
  sweeperRunOnce: () => void;
  toolPath: string;
  publicUrl: string;
  secretBox?: SecretBox;
}

export function registerCoreRoutes(app: Hono, deps: CoreDeps): void {
  app.route(
    "/v1/sessions",
    sessionsRouter({
      repo: deps.repo,
      tasks: deps.tasks,
      chat: deps.chat,
      config: deps.config,
      personas: deps.personas,
      processManager: deps.processManager,
      sessionTaskRecords: deps.sessionTaskRecords,
      transcriptLogs: deps.transcriptLogs,
      delegation: deps.delegation,
      channelDirectory: deps.channelDirectory,
      participants: deps.participants,
      resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots(),
      resolvePersonaInjectEnabled: () => deps.adminState.getPersonaInjectEnabled(),
      resolveCcWorkflowEnabled: () => deps.adminState.getCcWorkflowEnabled(),
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
  app.route("/v1/setup", setupRouter({ toolPath: deps.toolPath, url: deps.publicUrl }));
  app.route("/v1/skills", skillsRouter({ skills: deps.skills }));
  app.route("/v1/rules", rulesRouter({ rules: deps.rules }));
  app.route(
    "/v1/library",
    libraryRouter({ resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }),
  );
  app.route("/v1/stat", statRouter({ stats: deps.stats, sessions: deps.repo }));
  app.route("/v1/prs", prsRouter({ prs: deps.prs }));
  app.route("/v1/work", workRouter({ sessions: deps.repo, transcriptLogs: deps.transcriptLogs, resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }));
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
  app.route("/v1/delegation", delegationRouter({ repo: deps.delegation, service: deps.delegationService, sessions: deps.repo }));
  app.route("/v1/model-catalog", modelCatalogRouter({ repo: deps.modelCatalog }));
  if (deps.testingClaims) {
    app.route("/v1/testing", testingRouter({ claims: deps.testingClaims, sessions: deps.repo }));
  }
  if (deps.harnessRules) {
    app.route("/v1/harness-rules", harnessRulesRouter({ repo: deps.harnessRules }));
  }
  if (deps.harnessAudit && deps.harnessRules) {
    app.route(
      "/v1/harness",
      harnessSessionRouter({
        audit: deps.harnessAudit,
        rules: deps.harnessRules,
        runClaude: deps.harnessRunClaude,
        blackbox: deps.harnessBlackbox,
        // outside-scope 述語のスコープ源: target_project (明示) → repo_path (暗黙) の leaf。
        sessionScope: (id) => {
          const s = deps.repo.findSession(id);
          if (!s) return null;
          return s.target_project ?? s.repo_path ?? null;
        },
      }),
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
    const projectName = typeof body.project === "string" ? body.project.trim() : "";
    const requestedBranch = typeof body.branch === "string" ? body.branch.trim() : undefined;
    const requestedWorktree = body.worktree;
    let projectCwd: string | null = null;
    if (projectName) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(projectName)) {
        return c.json({ error: `invalid project name: ${projectName}` }, 400);
      }
      for (const root of deps.adminState.getWorkspaceRoots()) {
        const candidate = resolve(root, projectName);
        if (existsSync(candidate)) {
          projectCwd = candidate;
          break;
        }
      }
      if (!projectCwd) {
        return c.json({ error: `project not found under workspace roots: ${projectName}` }, 404);
      }
      if (typeof body.cwd === "string" && body.cwd.trim()) {
        return c.json({ error: "cwd and project are mutually exclusive (project fixes the cwd)" }, 400);
      }
    }
    const userPrompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : "";
    const restriction = projectName
      ? [
          `## 作業範囲の制限 (Concordia spawn)`,
          `このセッションはプロジェクト「${projectName}」専用です。`,
          `- 作業は cwd (${projectCwd}) 配下のみ。他のリポジトリ / ディレクトリの読み書き・commit・push は禁止。`,
          `- ${projectName} 以外の作業を指示された場合は、実行せずその旨を報告すること。`,
        ].join("\n")
      : "";
    const adHocPrompt = [restriction, userPrompt].filter(Boolean).join("\n\n");

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
      const runtimeOptions = {
        ...parseRuntimeOptions(tpl.runtime_options_json),
        ...(isPlainObject(body.options) ? (body.options as Record<string, unknown>) : {}),
      };
      const cwdOverride = projectCwd ?? (typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined);

      if (injectPrompt) {
        // prompt 注入あり = delegation invoke 本体に委譲 (render + prompt file + env + run 記録 + --model)。
        const result = await deps.delegationService.invoke({
          call_name: tpl.call_name,
          args: tplArgs,
          cwd: cwdOverride,
          branch: requestedBranch,
          worktree: typeof requestedWorktree === "boolean" ? requestedWorktree : undefined,
          triggered_by: "web-spawn",
          spawn: true,
          options: runtimeOptions,
          extra_prompt: adHocPrompt || undefined,
          project: projectName || null,
          subsidiary_id: subsidiaryId,
        });
        if (!result.ok) return c.json({ error: result.error, detail: result.details }, 400);
        return c.json({
          ok: true,
          pid: result.spawn_pid,
          command: result.spawn_command,
          run_id: result.run.id,
          injected_prompt: true,
          project: projectName || null,
          cwd: result.spawn_cwd,
          branch: result.spawn_branch,
          worktree_path: result.spawn_worktree_path,
          worktree_created: result.spawn_worktree_created,
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
      const runtimeArgs = resolveDelegationRuntimeArgs(tpl.target_provider, runtimeOptions);
      const spawnArgs = [...spawn.args, ...runtimeArgs];
      const spawnCwd = resolveSpawnCwd(tplCwd, deps.adminState.getWorkspaceRoot());
      const spawnTarget = await prepareSpawnTarget({
        cwd: spawnCwd,
        branch: requestedBranch,
        worktree: requestedWorktree,
      });
      if (!spawnTarget.ok) return c.json({ error: spawnTarget.error }, 400);
      const result = spawnSession({
        provider: spawn.provider,
        mode,
        args: spawnArgs.length > 0 ? spawnArgs : undefined,
        cwd: spawnTarget.cwd,
        cwdProvided: Boolean(tplCwd?.trim()),
        title: `tpl:${tpl.call_name}`,
        // gemma4-12 の LICTOR_LOCAL_MODEL 等、 spawn 解決由来の env を渡す。
        env: spawn.env,
      });
      if (!result.ok) return c.json({ error: result.error }, 400);
      // delegation_emoji を pending registry に登録。session.started 受信時に cwd で claim して metadata に焼く。
      recordPendingDelegationSpawn({ cwd: spawnTarget.cwd, emoji: tpl.emoji ?? null, callName: tpl.call_name, subsidiaryId, project: projectName || null });
      return c.json({
        ok: true,
        pid: result.pid,
        command: result.command,
        injected_prompt: false,
        project: projectName || null,
        cwd: spawnTarget.cwd ?? null,
        branch: spawnTarget.branch,
        worktree_path: spawnTarget.worktree_path,
        worktree_created: spawnTarget.worktree_created,
      });
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
    const runtimeArgs = resolveDelegationRuntimeArgs(
      provider,
      isPlainObject(body.options) ? (body.options as Record<string, unknown>) : {},
    );
    const userArgs = Array.isArray(body.args)
      ? (body.args as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const spawnEnv: Record<string, string> = { ...resolved.env };
    if (adHocPrompt) {
      spawnEnv.CONCORDIA_DELEGATION_PROMPT_FILE = deps.delegationService.writeAdHocPrompt(adHocPrompt);
    }
    const directCwd =
      projectCwd ?? resolveAgentHomeCwd(provider, body.cwd, deps.adminState.getWorkspaceRoot());
    const directTarget = await prepareSpawnTarget({
      cwd: directCwd,
      branch: requestedBranch,
      worktree: requestedWorktree,
    });
    if (!directTarget.ok) return c.json({ error: directTarget.error }, 400);
    const result = spawnSession({
      provider: resolved.provider,
      mode,
      args: [...resolved.args, ...runtimeArgs, ...userArgs],
      cwd: directTarget.cwd,
      cwdProvided:
        Boolean(projectCwd?.trim()) ||
        (typeof body.cwd === "string" && body.cwd.trim().length > 0),
      title: typeof body.title === "string" ? body.title : undefined,
      env: Object.keys(spawnEnv).length > 0 ? spawnEnv : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    // 子会社由来の素の provider spawn も subsidiary_id を焼く (本社流入防止)。 本社の通常
    // spawn では pending を積まない (cwd 衝突で他 delegation の claim を奪わないため)。
    if (subsidiaryId) {
      recordPendingDelegationSpawn({ cwd: directTarget.cwd, callName: "spawn", subsidiaryId, project: projectName || null });
    }
    return c.json({
      ok: true,
      pid: result.pid,
      command: result.command,
      injected_prompt: !!adHocPrompt,
      project: projectName || null,
      cwd: directTarget.cwd ?? null,
      branch: directTarget.branch,
      worktree_path: directTarget.worktree_path,
      worktree_created: directTarget.worktree_created,
    });
  });

  // 管理 API: spawn の既定値を UI に晒す.
  // body.cwd を省略したときに実際に使われる path と、 platform_supported を返す.
  app.get("/v1/admin/spawn-defaults", (c) => {
    return c.json({
      // 実際に spawn で使われる既定 cwd = プライマリ workspace ルート (実行時解決)。
      default_cwd: resolveCastraDefaultCwd(deps.adminState.getWorkspaceRoot()),
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
  // loopback (127.0.0.1) でしか上がってない前提で、 追加認証は付けない.
  // test 時は CONCORDIA_RESTART_DRY_RUN=1 で restart 副作用を skip.
  //
  // dev:backend / Excubitor 管理の標準形は `node --watch` 配下で動く。 watch 配下で
  // 旧実装のように `npm run dev:backend` を detached spawn すると、 旧 watch supervisor
  // が生き残ったまま新ツリーが立ち **supervisor が二重化** する。 以後ファイル変更の
  // たびに旧側の watch も子を再起動し、 port 11111 を取り合って EADDRINUSE クラッシュ
  // ループになる (2026-07-02 障害の根本原因)。
  // → watch 配下では新ツリーを作らず、 entry ファイルの mtime を touch して watcher
  //   自身に再起動させる (supervisor ツリーは 1 本のまま)。
  // watch 検出は Node watch 子プロセスの実測シグナル 2 点 (IPC channel が付く +
  // WATCH_REPORT_DEPENDENCIES が入る) の AND。 どちらも watch 以外では現れない。
  app.post("/v1/admin/restart", (c) => {
    if (process.env.CONCORDIA_RESTART_DRY_RUN === "1") {
      return c.json({ ok: true, dry_run: true });
    }
    const underWatch =
      typeof process.send === "function" && process.env.WATCH_REPORT_DEPENDENCIES !== undefined;
    if (underWatch) {
      const entry = resolve(process.argv[1] ?? "");
      // fail-fast: entry が実在しなければ touch では再起動できない (§9)。
      if (!entry || !existsSync(entry)) {
        return c.json({ ok: false, error: `restart entry not found: ${entry || "(empty argv[1])"}` }, 500);
      }
      // レスポンスを先に返してから touch する (watcher は touch 直後に SIGTERM してくる)。
      setTimeout(() => {
        const now = new Date();
        try {
          utimesSync(entry, now, now);
        } catch {
          // watcher 再起動と競合して ENOENT/EPERM になりうる; 次の restart 要求で再試行可
        }
      }, 100);
      return c.json({ ok: true, message: "restarting (watch-mode: entry touched, watcher restarts in-place)" });
    }
    // 非 watch (node dist/server.js 等): 従来通り detach spawn → 自分は exit(0)。
    // supervisor がいないのでツリー二重化は起きない。
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

}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
