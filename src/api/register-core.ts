import type { Hono } from "hono";
import { access, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { reportError } from "../errors.js";
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
import { prsRouter, type PrsApiDeps } from "./prs.js";
import { confirmRouter } from "./confirm.js";
import type { ConfirmService } from "../release/confirm-service.js";
import type { ProcessManager } from "../processes/manager.js";
import type { ProcessesRepo } from "../db/processes-repo.js";
import type { SkillsRepo } from "../db/skills-repo.js";
import type { RulesRepo } from "../db/rules-repo.js";
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
import type { SecretBox } from "../shared/secret-box.js";
import type { ChannelDirectory } from "./sessions/deps.js";
import { federationRouter, type FederationApiDeps } from "./federation.js";
import { spawnRouter } from "./spawn.js";
import { machinesRouter } from "./machines.js";
import { projectCodesRouter } from "./project-codes.js";
import { delegationRouter } from "./delegation.js";
import { parseRuntimeOptions, type DelegationRepo } from "../db/delegation-repo.js";
import type { DelegationService } from "../delegation/service.js";
import type { DelegationQueue } from "../delegation/queue.js";
import { substituteVars } from "../delegation/service.js";
import {
  forgetPendingDelegationSpawnBySpawnId,
  recordPendingDelegationSpawn,
} from "../control/pending-delegation-spawns.js";
import { modelCatalogRouter } from "./model-catalog.js";
import { subsidiaryRouter } from "./subsidiary.js";
import { createChildLogger } from "../shared/logger.js";
import { harnessRulesRouter } from "./harness-rules.js";
import { harnessSessionRouter } from "./harness-session.js";
import { injectManualsRouter } from "./inject-manuals.js";
import type { InjectManualsRepo } from "../db/inject-manuals-repo.js";
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
  type SpawnRequest,
  type SpawnResult,
  type SpawnMode,
} from "../control/spawner.js";
import { prepareSpawnTarget } from "../control/spawn-target.js";
import {
  goalAndGoRequested,
  resolveDelegationRuntimeArgs,
  resolveDelegationRuntimeEnv,
  resolveDelegationSpawn,
} from "../control/provider-preset.js";
import { resolveLocalModel } from "../control/famulus-select.js";
import { basename } from "node:path";
import { reapOrphans } from "../control/reaper.js";
import type { ControlJobsRepo } from "../db/control-jobs-repo.js";
import { runWsCleanup } from "../control/ws-cleanup.js";
import { runSessionEndFlow } from "../control/end-session-flow.js";
import { startDetachedBackendRestart } from "../control/backend-restart.js";
import type { TaskMdStore } from "../taskflow/md-store.js";
import { taskflowRouter } from "./taskflow.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import { mountRouteGroups } from "./route-groups.js";
import { CRON_JOBS, type CronJobDefinition } from "../scheduler/cron-jobs.js";

const restartLog = createChildLogger("api/backend-restart");

export interface CoreSessionDeps {
  repo: SessionsRepo;
  controlJobs: ControlJobsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  skills: SkillsRepo;
  rules: RulesRepo;
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
}

export interface CoreDelegationDeps {
  delegation: DelegationRepo;
  delegationService: DelegationService;
  /** 確認フロー (develop → 確認 → main)。 未注入なら /v1/confirm は生えない。 */
  confirmService?: ConfirmService;
  /** delegation 実行キュー (同時実行上限 + 待ち行列)。 未注入なら /v1/delegation/queue は 503。 */
  delegationQueue?: DelegationQueue;
  modelCatalog: ModelCatalogRepo;
  testingClaims?: import("../db/testing-claims-repo.js").TestingClaimsRepo;
  subsidiary?: SubsidiaryRepo;
  harnessRules?: HarnessRulesRepo;
  /** session の作業ブランチを Revisor へ local PR として提出する (レビュー発火)。 */
  submitLocalPr?: PrsApiDeps["submitLocalPr"];
  /** kind 別 Inject マニュアル。 未注入なら /v1/admin/inject-manuals は生えない。 */
  injectManuals?: InjectManualsRepo;
  harnessAudit?: HarnessAuditRepo;
  harnessRunClaude?: RunClaudeFn;
  harnessBlackbox?: HarnessBlackboxService;
  subsidiaryManager?: SubsidiaryBotManager;
  subsidiaryBudget?: SubsidiaryBudgetTracker;
}

export interface CoreRuntimeDeps {
  adminState: AdminState;
  costStatus?: () => CostBudgetStatus;
  processManager: ProcessManager;
  config: ConcordiaConfig;
  sweeperRunOnce: () => Promise<void>;
  toolPath: string;
  publicUrl: string;
  secretBox?: SecretBox;
  taskStore: TaskMdStore;
  onTaskflowCompleted: (run: DelegationRunRow) => Promise<void>;
  syncDiscordForumTags?: (templates: ReturnType<DelegationRepo["listTemplates"]>) => Promise<{ forum_id: string; tags: string[] }>;
  /** Direct interactive session launcher. Tests inject a host-independent stub. */
  sessionSpawn?: (request: SpawnRequest) => SpawnResult;
  /** マルチ拠点連合の管理 API。未注入なら /v1/federation は生えない。 */
  federation?: FederationApiDeps;
}

export type CoreDeps = CoreSessionDeps & CoreDelegationDeps & CoreRuntimeDeps;

export function registerCoreRoutes(app: Hono, deps: CoreDeps): void {
  const sessionSpawn = deps.sessionSpawn ?? spawnSession;
  mountRouteGroups([{ name: "session-runtime", mount: () => {
  app.route(
    "/v1/sessions",
    sessionsRouter({
      repo: deps.repo,
      controlJobs: deps.controlJobs,
      tasks: deps.tasks,
      chat: deps.chat,
      config: deps.config,
      processManager: deps.processManager,
      sessionTaskRecords: deps.sessionTaskRecords,
      transcriptLogs: deps.transcriptLogs,
      delegation: deps.delegation,
      channelDirectory: deps.channelDirectory,
      participants: deps.participants,
      resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots(),
      resolveCcWorkflowEnabled: () => deps.adminState.getCcWorkflowEnabled(),
      harnessAudit: deps.harnessAudit,
    }),
  );
  app.route("/v1/processes", processesRouter({ manager: deps.processManager, repo: deps.processes }));
  app.route("/v1/reports", reportsRouter({ repo: deps.repo, config: deps.config }));
  app.route(
    "/v1/session-logs",
    sessionLogsRouter({ resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }),
  );
  } }, { name: "knowledge-and-work", mount: () => {
  app.route("/v1/setup", setupRouter({ toolPath: deps.toolPath, url: deps.publicUrl }));
  app.route("/v1/skills", skillsRouter({ skills: deps.skills }));
  app.route("/v1/rules", rulesRouter({ rules: deps.rules }));
  app.route(
    "/v1/library",
    libraryRouter({ resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }),
  );
  app.route("/v1/stat", statRouter({ stats: deps.stats, sessions: deps.repo }));
  app.route("/v1/prs", prsRouter({ prs: deps.prs, submitLocalPr: deps.submitLocalPr }));
  app.route("/v1/taskflow", taskflowRouter({
    store: deps.taskStore,
    sessions: deps.repo,
    delegation: deps.delegation,
    prs: deps.prs,
  }));
  if (deps.confirmService) {
    app.route("/v1/confirm", confirmRouter({ service: deps.confirmService, testingClaims: deps.testingClaims }));
  }
  app.route("/v1/work", workRouter({ sessions: deps.repo, transcriptLogs: deps.transcriptLogs, resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }));
  } }, { name: "spawn-and-automation", mount: () => {
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
  app.route(
    "/v1/project-codes",
    projectCodesRouter({ resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots() }),
  );
  app.route("/v1/delegation", delegationRouter({
    repo: deps.delegation,
    service: deps.delegationService,
    sessions: deps.repo,
    queue: deps.delegationQueue
      ? {
          maxConcurrency: () => deps.delegationQueue!.maxConcurrency(),
          activeCount: () => deps.delegationQueue!.activeCount(),
          queuedCount: () => deps.delegationQueue!.queuedCount(),
          position: (runId) => deps.delegationQueue!.position(runId),
          drain: () => deps.delegationQueue!.drain(),
        }
      : undefined,
    adminState: deps.adminState,
    taskStore: deps.taskStore,
    onTaskflowCompleted: deps.onTaskflowCompleted,
    syncForumTags: deps.syncDiscordForumTags,
  }));
  app.route("/v1/model-catalog", modelCatalogRouter({ repo: deps.modelCatalog }));
  if (deps.testingClaims) {
    app.route("/v1/testing", testingRouter({ claims: deps.testingClaims, sessions: deps.repo }));
  }
  if (deps.harnessRules) {
    app.route("/v1/harness-rules", harnessRulesRouter({ repo: deps.harnessRules }));
  }
  // kind 別 Inject マニュアル (delegation 協調コンテキストへ差し込む作業マニュアル)。
  // /v1/admin/* なので app.ts の adminAuth middleware に乗る。
  if (deps.injectManuals) {
    app.route("/v1/admin/inject-manuals", injectManualsRouter({ repo: deps.injectManuals }));
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
        sessionContext: (id) => {
          const s = deps.repo.findSession(id);
          if (!s) return null;
          let metadata: Record<string, unknown> = {};
          try { metadata = s.metadata ? JSON.parse(s.metadata) as Record<string, unknown> : {}; } catch { /* allow unknown */ }
          const model = typeof metadata.model === "string" ? metadata.model : s.provider;
          return {
            model: `${s.provider}/${model}`,
            implUnlocked: metadata.impl_unlocked === true,
            isWorktree: typeof metadata.is_worktree === "boolean" ? metadata.is_worktree : undefined,
          };
        },
        strongImplModels: () => deps.adminState.getHarnessStrongImplModels(),
        mentionUserId: () => deps.adminState.getMentionUserId(),
      }),
    );
  }
  if (deps.federation) {
    app.route("/v1/federation", federationRouter(deps.federation));
  }
  if (deps.subsidiary && deps.subsidiaryManager && deps.secretBox) {
    app.route(
      "/v1/subsidiaries",
      subsidiaryRouter({ repo: deps.subsidiary, delegationRepo: deps.delegation, manager: deps.subsidiaryManager, secretBox: deps.secretBox, budget: deps.subsidiaryBudget, runClaude: deps.harnessRunClaude, log: createChildLogger("subsidiary-api") }),
    );
  }
  } }]);
  // クロスサービス cost-feed (Anatomia の同名パネルを複製。送信元は両方へ push しうる)。
  // env 解決の singleton を使うので AppDeps への配線は不要。
  app.post("/v1/sweeper/run", async (c) => {
    await deps.sweeperRunOnce();
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
        if (await access(candidate).then(() => true, () => false)) {
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
        if (result.run.status === "spawn_failed") {
          return c.json({
            error: result.run.error ?? "delegation spawn failed",
            run_id: result.run.id,
          }, 502);
        }
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
      // SessionStart can arrive immediately after wt.exe launch. Record the resolved
      // branch before spawn so Cc never loses the caller's requested branch.
      const spawnId = randomUUID();
      recordPendingDelegationSpawn({
        cwd: spawnTarget.cwd,
        spawnId,
        branch: spawnTarget.branch,
        emoji: tpl.emoji ?? null,
        callName: tpl.call_name,
        subsidiaryId,
        project: projectName || null,
        goalAndGo: goalAndGoRequested(runtimeOptions),
      });
      const result = sessionSpawn({
        provider: spawn.provider,
        mode,
        args: spawnArgs.length > 0 ? spawnArgs : undefined,
        cwd: spawnTarget.cwd,
        cwdProvided: Boolean(tplCwd?.trim()),
        title: `tpl:${tpl.call_name}`,
        // gemma4-12 の LICTOR_LOCAL_MODEL 等、 spawn 解決由来の env を渡す。
        env: { ...(spawn.env ?? {}), ...resolveDelegationRuntimeEnv(tpl.target_provider, runtimeOptions) },
        spawnId,
      });
      if (!result.ok) {
        forgetPendingDelegationSpawnBySpawnId(spawnId);
        return c.json({ error: result.error }, 400);
      }
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
    const directOptions = isPlainObject(body.options) ? (body.options as Record<string, unknown>) : {};
    const runtimeArgs = resolveDelegationRuntimeArgs(provider, directOptions);
    const userArgs = Array.isArray(body.args)
      ? (body.args as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const spawnEnv: Record<string, string> = {
      ...resolved.env,
      ...resolveDelegationRuntimeEnv(provider, directOptions),
    };
    if (adHocPrompt) {
      spawnEnv.CONCORDIA_DELEGATION_PROMPT_FILE = await deps.delegationService.writeAdHocPrompt(adHocPrompt);
    }
    const directCwd =
      projectCwd ?? resolveAgentHomeCwd(provider, body.cwd, deps.adminState.getWorkspaceRoot());
    const directTarget = await prepareSpawnTarget({
      cwd: directCwd,
      branch: requestedBranch,
      worktree: requestedWorktree,
    });
    if (!directTarget.ok) return c.json({ error: directTarget.error }, 400);
    const spawnId = randomUUID();
    recordPendingDelegationSpawn({
      cwd: directTarget.cwd,
      spawnId,
      branch: directTarget.branch,
      callName: "spawn",
      subsidiaryId,
      project: projectName || null,
      goalAndGo: goalAndGoRequested(directOptions),
    });
    const result = sessionSpawn({
      provider: resolved.provider,
      mode,
      args: [...resolved.args, ...runtimeArgs, ...userArgs],
      cwd: directTarget.cwd,
      cwdProvided:
        Boolean(projectCwd?.trim()) ||
        (typeof body.cwd === "string" && body.cwd.trim().length > 0),
      title: typeof body.title === "string" ? body.title : undefined,
      env: Object.keys(spawnEnv).length > 0 ? spawnEnv : undefined,
      spawnId,
    });
    if (!result.ok) {
      forgetPendingDelegationSpawnBySpawnId(spawnId);
      return c.json({ error: result.error }, 400);
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
  // 3. session-end フロー (report 生成 / 独白を #報告 へ投稿) を実行
  // 4. 独白後に durable control queue へ停止ジョブを登録する。
  //    taskkill / signal は別プロセスの control-worker が実行する。
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
        config: deps.config,
        harnessAudit: deps.harnessAudit,
      },
      ended,
    );
    const lictorJob = deps.controlJobs.enqueueStopProcess({
      pid: meta.lictor_pid,
      source: "admin-stop-session",
      sessionId: id,
      role: "lictor",
      expectedCommand: null,
    });
    let agentClientJob: ReturnType<ControlJobsRepo["enqueueStopProcess"]> | null = null;
    if (typeof meta.agent_client_pid === "number") {
      agentClientJob = deps.controlJobs.enqueueStopProcess({
        pid: meta.agent_client_pid,
        source: "admin-stop-session",
        sessionId: id,
        role: "agent-client",
        expectedCommand: null,
      });
    }
    return c.json({
      ok: true,
      status: "queued",
      pid: meta.lictor_pid,
      agent_client_pid: meta.agent_client_pid ?? null,
      job_id: lictorJob.id,
      agent_client_job_id: agentClientJob?.id ?? null,
      report_generated: flow.report !== null,
      monologue_posted: flow.postedMessageId !== null,
    }, 202);
  });

  // ── 管理 API: 孤児プロセス回収 (reaper) ─────────────────────────────
  // GET  /v1/admin/orphans : dry-run。 終了/消滅 session に紐付かない Lictor/agent-client の一覧。
  // POST /v1/admin/reap    : 回収実行 (kill)。 body {dry_run?: boolean, min_age_sec?: number}。
  app.get("/v1/admin/orphans", async (c) => {
    const r = await reapOrphans({ repo: deps.repo, controlJobs: deps.controlJobs }, {
      dryRun: true,
      minAgeSec: deps.config.reaperMinAgeSec,
      lostGraceSec: deps.config.reaperLostGraceSec,
    });
    return c.json({ scanned: r.scanned, lost_sessions: r.lost.candidates, orphans: r.orphans });
  });
  app.post("/v1/admin/reap", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { dry_run?: boolean; min_age_sec?: number };
    const minAgeSec =
      typeof body.min_age_sec === "number" && body.min_age_sec >= 0
        ? body.min_age_sec
        : deps.config.reaperMinAgeSec;
    const r = await reapOrphans(
      { repo: deps.repo, controlJobs: deps.controlJobs },
      {
        dryRun: body.dry_run === true,
        minAgeSec,
        lostGraceSec: deps.config.reaperLostGraceSec,
      },
    );
    return c.json({
      scanned: r.scanned,
      orphans: r.orphans.length,
      lost_sessions: r.lost.candidates.length,
      queued: r.queued.length,
      killed: r.lost.killed.length,
      failed: r.failed.length + r.lost.failed.length,
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

  // レビュー発火 (セッション終了時の local PR 自動提出) の安全弁。 既定 ON で、
  // 購読側が毎回 live 評価するので即時反映。 spec/feature/revisor-local-pr-submission.md §2
  app.get("/v1/admin/revisor-auto-submit", (c) => {
    return c.json({ enabled: deps.adminState.getRevisorAutoSubmitEnabled() });
  });
  app.put("/v1/admin/revisor-auto-submit", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled (boolean) required" }, 400);
    }
    deps.adminState.setRevisorAutoSubmitEnabled(body.enabled);
    return c.json({ enabled: deps.adminState.getRevisorAutoSubmitEnabled() });
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
  app.put("/v1/admin/harness-strong-impl-models", async (c) => {
    const body = await c.req.json().catch(() => null) as { models?: unknown } | null;
    if (!body || !Array.isArray(body.models) || body.models.some((model) => typeof model !== "string")) {
      return c.json({ error: "models_must_be_string_array" }, 400);
    }
    deps.adminState.setHarnessStrongImplModels(body.models as string[]);
    return c.json({ models: deps.adminState.getHarnessStrongImplModels() });
  });
  app.put("/v1/admin/mention-user-id", async (c) => {
    const body = await c.req.json().catch(() => null) as { user_id?: unknown } | null;
    if (!body || (body.user_id !== null && typeof body.user_id !== "string")) return c.json({ error: "invalid_user_id" }, 400);
    deps.adminState.setMentionUserId(body.user_id as string | null);
    return c.json({ user_id: deps.adminState.getMentionUserId() });
  });

  // 内部 cron (src/scheduler/cron-jobs.ts) が起動する call_name を WebUI から切り替える。
  // override は schema_meta 永続化 (AdminState) なので再起動不要・次回発火から反映される。
  // cron-jobs.ts の既定値自体は変えない (override 未設定時のフォールバック)。
  function serializeCronJob(job: CronJobDefinition) {
    return {
      name: job.name,
      cron: job.cron,
      default_call_name: job.call_name,
      call_name: deps.adminState.getCronJobOverride(job.name) ?? job.call_name,
    };
  }
  app.get("/v1/admin/cron-jobs", (c) => {
    return c.json({ jobs: CRON_JOBS.map(serializeCronJob) });
  });
  app.put("/v1/admin/cron-jobs/:name", async (c) => {
    const name = c.req.param("name");
    const job = CRON_JOBS.find((j) => j.name === name);
    if (!job) return c.json({ error: `unknown cron job: ${name}` }, 404);
    const body = await c.req.json().catch(() => null) as { call_name?: unknown } | null;
    if (!body || (body.call_name !== null && typeof body.call_name !== "string")) {
      return c.json({ error: "body.call_name (string or null) required" }, 400);
    }
    const callName = body.call_name as string | null;
    if (callName !== null) {
      const tpl = deps.delegation.findTemplateByCallName(callName);
      if (!tpl) return c.json({ error: `unknown call_name: ${callName}` }, 404);
      if (!tpl.is_active) return c.json({ error: `template is inactive: ${callName}` }, 400);
    }
    deps.adminState.setCronJobOverride(name, callName);
    return c.json({ job: serializeCronJob(job) });
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
  app.post("/v1/admin/restart", async (c) => {
    if (process.env.CONCORDIA_RESTART_DRY_RUN === "1") {
      return c.json({ ok: true, dry_run: true });
    }
    const underWatch =
      typeof process.send === "function" && process.env.WATCH_REPORT_DEPENDENCIES !== undefined;
    if (underWatch) {
      const entry = resolve(process.argv[1] ?? "");
      // fail-fast: entry が実在しなければ touch では再起動できない (§9)。
      if (!entry || !(await access(entry).then(() => true, () => false))) {
        return c.json({ ok: false, error: `restart entry not found: ${entry || "(empty argv[1])"}` }, 500);
      }
      // レスポンスを先に返してから touch する (watcher は touch 直後に SIGTERM してくる)。
      // この時点で HTTP 応答は既に返却済みなので utimes 失敗を呼び出し元へ直接
      // エラー応答で返すことはできない。 だが黙って握り潰すと「再起動を要求したのに
      // 実際には touch が失敗して watcher が再起動しない」 サイレント故障になる
      // (継続レビュー指摘)。 reportError で errors チャンネルへ明示的に報告し、
      // 少なくとも観測可能にする (§6 無言のフォールバック禁止)。
      setTimeout(() => {
        const now = new Date();
        // watcher 再起動と競合して ENOENT/EPERM になりうる; 次の restart 要求で再試行可。
        void utimes(entry, now, now).catch((err: unknown) => {
          const msg = `watch-mode restart touch failed entry=${entry}: ${(err as Error).message}`;
          restartLog.error(msg);
          reportError("api/backend-restart", msg, { entry });
        });
      }, 100);
      return c.json({ ok: true, message: "restarting (watch-mode: entry touched, watcher restarts in-place)" });
    }
    // 非 watch (node dist/server.js 等): 従来通り detach spawn → 自分は exit(0)。
    // supervisor がいないのでツリー二重化は起きない。
    setTimeout(() => {
      startDetachedBackendRestart({
        cwd: process.cwd(),
        log: { error: (message) => restartLog.error(message) },
      });
    }, 100);
    return c.json({ ok: true, message: "restarting (child spawning, parent will exit in ~300ms)" });
  });

}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
