/**
 * Delegation service: テンプレ render + invoke (spawn 連携 + 記録).
 *
 * spec/delegation.md §3-4.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type DelegationRepo,
  type DelegationProvider,
  type DelegationRunRow,
  parseRuntimeOptions,
} from "../db/delegation-repo.js";
import {
  CLAUDE_OPUS_DEFAULT_EFFORT,
  isClaudeOpusModel,
  isCodexFamilyProvider,
  resolveEffectiveDelegationRuntimeOptions,
  resolveDelegationRuntimeArgs,
  resolveDelegationSpawn,
  normalizeProviderEffort,
  GEMMA4_12_DEFAULT_MODEL,
  type DelegationRuntimeOptions,
} from "../control/provider-preset.js";
import { prepareSpawnTarget, type SpawnWorktreeState } from "../control/spawn-target.js";
import { resolveDelegationBranch } from "./branch-source.js";
import { buildDelegationContext } from "./persona-context.js";
import { resolveManualKind } from "./manual-kind.js";
import {
  IMPLEMENTATION_MANUAL_KIND,
  buildImplementationInject,
  buildMemoriaTaskDraft,
  resolveWhy,
  type MemoriaTaskLink,
} from "./implementation-inject.js";
import { buildParttimerInject } from "./parttimer-inject.js";
import { createDelegationMemoriaTask, type DelegationMemoriaPort } from "./memoria-task.js";
import { createChildLogger } from "../shared/logger.js";
import { baselineEffort, classifyTaskEffort, supportsAutomaticEffort, type EffortTaskBucket } from "./effort-policy.js";
import type { DelegationEffortBlackbox } from "./effort-blackbox.js";
import { buildInvocationPlan } from "./plan.js";
import { recoverCollapsedWindowsWorkspacePath } from "./windows-path-recovery.js";
import { substituteVars } from "./prompt.js";
import {
  buildDomainPreamble,
  domainPreambleEnabled,
  isDomainPreambleTarget,
  pickDelegationTaskText,
  prependDomainPreamble,
} from "./domain-preamble.js";
import {
  templateToDefinition,
  type DelegationDefinition,
  type InvokeInput,
  type QueuePayload,
  type LaunchResult,
} from "./contracts.js";
import { executeQueuedRun } from "./executor.js";
import { launchDelegationProcess, type DelegationSpawner } from "./launcher.js";
import { augurCliCommand, resolveAugurCliPath } from "./augur-acceptance.js";
import {
  buildExternalDocBundle,
  collectExternalDocRefs,
  type RegisteredRepo,
} from "./external-docs.js";
import { applyDelegationProviderPolicy } from "./provider-policy.js";
import { resolveTemplateForScope } from "./template-overrides.js";
import { readFederationEnv } from "../federation/env.js";
import { normalizeSubsidiaryId } from "../shared/subsidiary-id.js";
export { resolveDelegationSpawner } from "./launcher.js";
export { templateToDefinition } from "./contracts.js";
export type { DelegationDefinition, InvokeInput } from "./contracts.js";
export { renderTemplate, substituteVars, validateArgs } from "./prompt.js";

const log = createChildLogger("delegation/service");

/// 静的文字列内の `${var}` を args から埋める (fallback 構文 `${var:fb}` 対応)。
/// renderTemplate と違って schema チェックや missing 追跡はしない (cwd 用)。
/// app.ts の spawn-from-template (素のセッション) 経路も同じ展開を使うため export。
/**
 * 起動に必要な delegation 定義の最小集合。 グローバルテンプレ (delegation_templates) と
 * 子会社所有の複製 (subsidiary_delegations) を同じ起動経路 (runDefinition) に載せるための共通形。
 */

export interface InvokeResultOk {
  ok: true;
  run: DelegationRunRow;
  prompt_file_path: string;
  rendered_prompt: string;
  spawn_pid: number | null;
  spawn_command: string[] | null;
  spawn_cwd: string | null;
  spawn_branch: string | null;
  spawn_worktree_path: string | null;
  spawn_worktree_created: boolean;
  spawn_worktree_state: SpawnWorktreeState | null;
  /** true = 同時実行上限に達していたため spawn せずキューに入れた (status='queued')。 */
  queued: boolean;
  /** queued のときの待ち順 (1 始まり)。 それ以外は null。 */
  queue_position: number | null;
}

/**
 * 実行キュー (delegation/queue.ts) のうち service が使う口だけを切り出したもの。
 * queue → service (spawnQueuedRun) の逆向き依存があるため、 型の循環を避けて薄く持つ。
 */
export interface DelegationQueuePort {
  enabled(): boolean;
  hasCapacity(): boolean;
  position(runId: string): number | null;
}

/** queued run を後から起動するために保存しておく入力一式。 */
export interface InvokeResultErr {
  ok: false;
  error: string;
  details?: unknown;
}

export type InvokeResult = InvokeResultOk | InvokeResultErr;

export interface DelegationServiceDeps {
  repo: DelegationRepo;
  /** 端末 spawn を上書き (テスト用)。 省略時は実際に wt.exe を起動 */
  spawn?: DelegationSpawner;
  /** prompt file の出力先 dir (default = process.cwd()/delegation-prompts) */
  promptsDir?: string;
  /** delegation context に載せる協調 API URL。 */
  concordiaUrl?: string;
  /** DB → env 解決済みの federation site ID。未注入時は env のみを参照する。 */
  siteId?: () => string | null;
  /** Growth blackbox used for provider-independent effort selection. */
  effortBlackbox?: DelegationEffortBlackbox;
  /**
   * kind 別 Inject マニュアルの解決 (inject_manuals から引く)。 未注入なら差し込まない。
   * kind は resolveManualKind (manual-kind.ts) がテンプレから解決する。
   */
  injectManual?: (kind: string) => string | null;
  /**
   * Genius command-pattern の push 注入 (delegation/command-patterns.ts)。
   * task 文面に一致した定型手順ブロックを返す。 不在・不一致・失敗は null (fail-soft)。
   */
  commandPatterns?: (taskText: string) => Promise<string | null>;
  teamRules?: (teamIdOrSlug: string) => {
    id: string;
    team: string;
    rules: string;
    subsidiaryId: string | null;
  } | null;
  /** team settings `pr_rules` (teams §3.1)。 委託 brief の base branch 案内へ反映する。 */
  teamPrRules?: (teamIdOrSlug: string) => { base: string; push: "revisor" } | null;
  /**
   * 実装委託の追跡タスクを起票する Memoria の口。 composition root で遅延解決するため
   * 関数で受ける。 未注入・失敗は fail-soft (委託は止めず、 未起票を本文へ書く)。
   */
  memoria?: () => DelegationMemoriaPort | null;
  /**
   * 管理者メンション ID (`admin.mention_user_id`) の解決。 パートタイマーの最終報告に
   * 付ける値を Cc 側で埋めるために受ける。 未注入・未設定は null (メンションなし)。
   */
  mentionUserId?: () => string | null;
  /** Augur CLI を探すワークスペースルート群 (受け入れ条件の集計コマンドを本文へ載せるため)。 */
  workspaceRoots?: () => string[];
  /** 登録済みプロジェクト。 別リポ md の同梱可否をここで判定する。 */
  registeredRepos?: () => RegisteredRepo[];
  /** 作業ディレクトリが属する登録済み repo の解決 (同じ repo の文書は同梱しない)。 */
  resolveRepoForPath?: (path: string) => RegisteredRepo | null;
}

export class DelegationService {
  private queue: DelegationQueuePort | null = null;

  constructor(private readonly deps: DelegationServiceDeps) {}

  /**
   * 実行キューを後付けで繋ぐ。 queue は spawn のために service を呼び、 service は
   * 空きスロット判定のために queue を呼ぶ相互依存なので、 合成は composition root で
   * 「service を作る → queue を作る → setQueue」 の順に行う。
   */
  setQueue(queue: DelegationQueuePort | null): void {
    this.queue = queue;
  }

  private get promptsDir(): string {
    return this.deps.promptsDir ?? join(process.cwd(), "delegation-prompts");
  }

  /**
   * テンプレを介さない自由テキストの初回プロンプトを prompt file に書き出し、 そのパスを返す。
   * 呼び出し側は `CONCORDIA_DELEGATION_PROMPT_FILE` に渡して素の provider spawn に注入する
   * (Lictor が起動直後に paste+submit する)。 /spawn の prompt 欄 / 返信由来 spawn が使う。
   */
  async writeAdHocPrompt(prompt: string): Promise<string> {
    await mkdir(this.promptsDir, { recursive: true });
    const path = join(this.promptsDir, `${randomUUID()}.md`);
    await writeFile(path, prompt, "utf8");
    return path;
  }

  /**
   * call_name でグローバルテンプレを解決して起動する (従来経路)。 内部で runDefinition に委ねる。
   */
  async invoke(input: InvokeInput): Promise<InvokeResult> {
    const tpl = this.deps.repo.findTemplateByCallName(input.call_name);
    if (!tpl) return { ok: false, error: `unknown call_name: ${input.call_name}` };
    const scope = {
      platform: process.platform,
      siteId: this.deps.siteId
        ? this.deps.siteId()
        : readFederationEnv(process.env, { deferListenerPortValidation: true }).siteId,
    };
    const resolved = resolveTemplateForScope(tpl, this.deps.repo.listTemplateOverrides(tpl.id), scope);
    if (!resolved.is_active) return { ok: false, error: `template is inactive: ${input.call_name}` };
    return this.runDefinition(templateToDefinition(resolved), input);
  }

  /**
   * グローバルテンプレを介さず、 与えられた delegation 定義をそのまま起動する。
   * 子会社が「所有する」 delegation の複製 (cwd / project / prompt が独立) を起動するための経路。
   */
  async invokeDefinition(def: DelegationDefinition, input: Omit<InvokeInput, "call_name">): Promise<InvokeResult> {
    return this.runDefinition(def, { ...input, call_name: def.call_name });
  }

  private async runDefinition(def: DelegationDefinition, input: InvokeInput): Promise<InvokeResult> {
    input = normalizeInvocationPaths(input);
    const subsidiaryId = normalizeSubsidiaryId(input.subsidiary_id);
    if (input.subsidiary_id != null && !subsidiaryId) {
      return { ok: false, error: "invalid subsidiary_id" };
    }
    input = { ...input, subsidiary_id: subsidiaryId };
    const requestedTeamValue = typeof input.options?.team === "string" ? input.options.team.trim() : "";
    const requestedTeam = requestedTeamValue ? this.deps.teamRules?.(requestedTeamValue) ?? null : null;
    if (requestedTeamValue && !requestedTeam) {
      return { ok: false, error: `unknown team: ${requestedTeamValue}` };
    }
    if (requestedTeam && requestedTeam.subsidiaryId !== subsidiaryId) {
      return { ok: false, error: "team is not owned by the requested organization" };
    }
    if (requestedTeam) {
      input = { ...input, options: { ...input.options, team: requestedTeam.id } };
    }
    const plan = buildInvocationPlan(def, input);
    if (!plan.ok) return plan;
    // 委託前にドメインを確定して指示書の先頭へ織り込む (設計 §5 C-2 / §12.3 C-11)。
    // Anatomia が居ない / 索引に無い / ドメイン定義が無いときは何も足さずに進む。
    const renderedPrompt = await this.applyDomainPreamble(def, input, plan.renderedPrompt);

    // 指示書の本文と構造化 branch を突き合わせる。 本文だけが branch を指している
    // 場合は呼び出し元の渡し忘れなので、 worktree を作らないまま spawn させない
    // (2026-09-05 の共有 checkout 着地事故)。 /v1/delegation/invoke と
    // /v1/admin/spawn の両経路がここを通るため、 検証は 1 箇所で足りる。
    const branchResolution = resolveDelegationBranch({
      contractBranch: input.contract_branch,
      argumentBranch: typeof input.branch === "string" ? input.branch : null,
      promptText: renderedPrompt,
    });
    if (!branchResolution.ok) return { ok: false, error: branchResolution.error };
    input = { ...input, branch: branchResolution.branch ?? undefined };

    const runId = randomUUID();
    const startedAt = Date.now();
    const promptPath = join(this.promptsDir, `${runId}.md`);
    const shouldSpawn = input.spawn !== false;

    // 同時実行上限に達していれば spawn せずキューに入れる。 worktree 作成・prompt file
    // 書き出しといった副作用は起動時 (launch) までまとめて遅延させる — 待たせている間に
    // worktree だけ先に生えている、 という中途半端な状態を作らないため。
    if (shouldSpawn && this.queue?.enabled() && !this.queue.hasCapacity()) {
      const payload: QueuePayload = { def, input, startedAt };
      const targetProvider = applyDelegationProviderPolicy(input.overrides?.provider ?? def.target_provider);
      const run = this.deps.repo.createRun({
        id: runId,
        template_id: def.template_id,
        category: def.category ?? null,
        call_name: def.call_name,
        target_provider: targetProvider,
        parent_session_id: input.parent_session_id ?? null,
        args: input.args ?? {},
        rendered_prompt: renderedPrompt,
        prompt_file_path: promptPath,
        spawn_pid: null,
        spawn_command: null,
        triggered_by: input.triggered_by ?? null,
        status: "queued",
        queue_payload_json: JSON.stringify(payload),
        team_id: requestedTeam?.id ?? null,
        subsidiary_id: input.subsidiary_id ?? null,
        created_at: startedAt,
      });
      const position = this.queue.position(run.id);
      log.info({ run_id: run.id, call_name: def.call_name, queue_position: position }, "delegation queued (at concurrency limit)");
      return {
        ok: true,
        run,
        prompt_file_path: promptPath,
        rendered_prompt: renderedPrompt,
        spawn_pid: null,
        spawn_command: null,
        spawn_cwd: null,
        spawn_branch: null,
        spawn_worktree_path: null,
        spawn_worktree_created: false,
        spawn_worktree_state: null,
        queued: true,
        queue_position: position,
      };
    }

    const launch = await this.launch(runId, def, input, renderedPrompt, shouldSpawn, startedAt);
    if (!launch.ok) return { ok: false, error: launch.error };

    const run = this.deps.repo.createRun({
      id: runId,
      template_id: def.template_id,
      category: def.category ?? null,
      call_name: def.call_name,
      target_provider: launch.provider,
      parent_session_id: input.parent_session_id ?? null,
      args: input.args ?? {},
      rendered_prompt: renderedPrompt,
      prompt_file_path: promptPath,
      spawn_pid: launch.spawn_pid,
      spawn_command: launch.spawn_command,
      triggered_by: input.triggered_by ?? null,
      status: launch.status,
      error: launch.error_message,
      effort_level: launch.effort_level,
      effort_source: launch.effort_source,
      effort_bucket: launch.effort_bucket,
      effective_model: launch.effective_model,
      fast_mode: launch.fast_mode,
      spawn_cwd: launch.cwd,
      spawn_branch: launch.branch,
      spawn_worktree_path: launch.worktree_path,
      spawn_worktree_created: launch.worktree_created,
      spawn_worktree_state: launch.worktree_state,
      effort_decision_id: launch.effort_decision_id,
      team_id: requestedTeam?.id ?? null,
      subsidiary_id: input.subsidiary_id ?? null,
      created_at: startedAt,
    });
    if (launch.memoria_task) {
      this.deps.repo.recordMemoriaTask(runId, launch.memoria_task.id, launch.memoria_task.url);
    }
    if (launch.bundled_docs.length > 0) {
      this.deps.repo.recordBundledDocs(runId, launch.bundled_docs);
    }

    return {
      ok: true,
      run,
      prompt_file_path: promptPath,
      rendered_prompt: renderedPrompt,
      spawn_pid: launch.spawn_pid,
      spawn_command: launch.spawn_command,
      spawn_cwd: launch.cwd ?? null,
      spawn_branch: launch.branch,
      spawn_worktree_path: launch.worktree_path,
      spawn_worktree_created: launch.worktree_created,
      spawn_worktree_state: launch.worktree_state,
      queued: false,
      queue_position: null,
    };
  }

  /**
   * 指示書の先頭に「ドメイン先行」の前置きを足す (設計 §5 C-2 / §12.3-12.4 C-11)。
   *
   * 対象は実装を伴うテンプレ (employee / freelancer) で、 依頼文が args にあるものだけ。
   * パートタイマーの定型タスクや call_only の雑務にドメイン計画は要らない。
   * **失敗しても委託は止めない** — 織り込みを飛ばして従来どおりの指示書を返す。
   */
  private async applyDomainPreamble(
    def: DelegationDefinition,
    input: InvokeInput,
    renderedPrompt: string,
  ): Promise<string> {
    if (!domainPreambleEnabled()) return renderedPrompt;
    // freelancer には設計相談・レビューも含まれる。category だけで判定すると読み取り専用
    // テンプレへ実装向け前置きと最大 10 秒の I/O を足すため、既存の manual kind 正本を使う。
    if (!isDomainPreambleTarget({
      callName: def.call_name,
      title: def.title,
      category: def.category,
    })) return renderedPrompt;
    const args = input.args ?? {};
    const task = pickDelegationTaskText(args);
    if (!task) return renderedPrompt;
    const targetRepo = typeof args.target_repo === "string" && args.target_repo.trim()
      ? args.target_repo.trim()
      : input.cwd ?? null;
    try {
      const preamble = await buildDomainPreamble({ task, targetRepo });
      if (preamble.text) {
        log.info(
          { call_name: def.call_name, project: preamble.project, source: preamble.source },
          "delegation domain preamble applied",
        );
      }
      return prependDomainPreamble(renderedPrompt, preamble);
    } catch (e) {
      log.warn(
        { call_name: def.call_name, error: (e as Error).message },
        "delegation domain preamble skipped",
      );
      return renderedPrompt;
    }
  }

  /**
   * キュー待ちだった run を起動する (DelegationQueue から呼ばれる)。 payload から
   * 起動入力を復元し、 invoke 時と同じ launch を通してから run に結果を焼き戻す。
   */
  async spawnQueuedRun(run: DelegationRunRow): Promise<void> {
    await executeQueuedRun({
      run,
      repo: this.deps.repo,
      launch: (payload) => this.launch(
        run.id,
        payload.def,
        payload.input,
        run.rendered_prompt,
        true,
        payload.startedAt ?? run.created_at,
      ),
    });
  }

  recordEffortOutcome(run: DelegationRunRow, status: "completed" | "failed"): void {
    if (!this.deps.effortBlackbox || run.effort_decision_id == null) return;
    this.deps.effortBlackbox.recordOutcome(run.effort_decision_id, status);
  }

  /**
   * 起動の副作用一式: cwd/branch/worktree 解決 → model 解決 → prompt file 書き出し →
   * spawn。 invoke 直起動と キュー払い出し の両方がここを通る (spawn=false なら
   * prompt file までで止める)。
   *
   * ok:false = run 行を作る前の失敗 (worktree 準備 / prompt file 書き出し)。
   * ok:true + status='spawn_failed' = spawn 自体の失敗 (run 行に残す)。
   */
  private async launch(
    runId: string,
    def: DelegationDefinition,
    input: InvokeInput,
    renderedPrompt: string,
    shouldSpawn: boolean,
    startedAt = Date.now(),
  ): Promise<LaunchResult> {
    const requestedProvider = input.overrides?.provider ?? def.target_provider;
    const provider = applyDelegationProviderPolicy(requestedProvider);
    // cwd 解決 (auto-model のヒントにも使うので resolveDelegationSpawn より先に行う):
    // 1) caller 指定 → 2) definition.default_cwd を args で `${var}` 展開
    // → 3) どちらも無ければ undefined (= wt が user-home で開く)。
    let cwd: string | undefined = input.cwd ?? undefined;
    if (!cwd && def.default_cwd) {
      const expanded = substituteVars(def.default_cwd, input.args ?? {}).trim();
      cwd = expanded === "" ? undefined : expanded;
    }
    let spawnBranch: string | null = null;
    let spawnWorktreePath: string | null = null;
    let spawnWorktreeCreated = false;
    let spawnWorktreeState: SpawnWorktreeState | null = null;
    if (shouldSpawn) {
      const target = await prepareSpawnTarget({
        cwd,
        branch: input.branch,
        worktree: input.worktree,
      });
      if (!target.ok) return { ok: false, error: target.error };
      cwd = target.cwd;
      spawnBranch = target.branch;
      spawnWorktreePath = target.worktree_path;
      spawnWorktreeCreated = target.worktree_created;
      spawnWorktreeState = target.worktree_state;
    }
    // Famulus は model 選択経路から外す。 local-LLM の auto は Cc が管理する catalog
    // 既定へ解決し、Genius model-review が hit した場合だけ明示候補で上書きされる。
    let modelInput = input.overrides?.model !== undefined ? input.overrides.model : def.model;
    if (provider === "gemma4-12" && (modelInput ?? "").trim().toLowerCase() === "auto") {
      modelInput = GEMMA4_12_DEFAULT_MODEL;
      log.info({ call_name: def.call_name, resolved_model: modelInput }, "Cc local auto-model resolved");
    }
    // 論理 provider (gemma4-12 等) → 実 spawn (CLI + args + env) に解決 (単一情報源)。
    const spawn = resolveDelegationSpawn(provider, modelInput);
    const templateOptions = parseRuntimeOptions(def.runtime_options_json);
    const oneShotOptions = input.options ?? {};
    const requestedEffort = findRequestedEffort(provider, templateOptions, oneShotOptions, input.overrides);
    let effortLevel: string | null = null;
    let effortSource: string | null = null;
    let effortBucket: EffortTaskBucket | null = null;
    let effortDecisionId: number | null = null;
    let effortConfidence: number | null = null;
    if (isClaudeOpusModel(provider, spawn.effectiveModel) && requestedEffort === null) {
      effortLevel = CLAUDE_OPUS_DEFAULT_EFFORT;
      effortSource = "opus-default";
    } else if (supportsAutomaticEffort(provider)) {
      effortBucket = classifyTaskEffort(renderedPrompt);
      if (requestedEffort && !isAutoEffort(requestedEffort.value)) {
        const normalized = normalizeProviderEffort(provider, requestedEffort.value);
        if (!normalized) {
          return { ok: false, error: `invalid ${requestedProvider} effort: ${String(requestedEffort.value)}` };
        }
        effortLevel = normalized;
        effortSource = requestedEffort.source;
      } else if (this.deps.effortBlackbox) {
        const decision = await this.deps.effortBlackbox.decide({
          provider,
          model: spawn.effectiveModel,
          prompt: renderedPrompt,
          callName: def.call_name,
          project: def.project ?? null,
        });
        effortLevel = decision.level;
        effortSource = decision.source;
        effortBucket = decision.bucket;
        effortDecisionId = decision.decision_id;
        effortConfidence = decision.confidence;
      } else {
        effortLevel = baselineEffort(effortBucket);
        effortSource = "auto-baseline";
      }
    }
    // codex ファミリ (codex / codex-sdk) は model_reasoning_effort、 claude は effort。
    // resolveEffectiveDelegationRuntimeOptions / resolveDelegationRuntimeArgs が
    // codex ファミリで読むのは model_reasoning_effort (と reasoning_effort) だけなので、
    // ここで `effort` に載せると決定した effort が黙って捨てられ既定 xhigh になる。
    const effortOptions = effortLevel
      ? isCodexFamilyProvider(provider)
        ? { model_reasoning_effort: effortLevel }
        : { effort: effortLevel }
      : {};
    const effectiveOptions = resolveEffectiveDelegationRuntimeOptions(
      provider,
      {
        ...templateOptions,
        ...oneShotOptions,
        ...(input.overrides?.reasoning_effort ? { reasoning_effort: input.overrides.reasoning_effort } : {}),
        ...effortOptions,
      },
      spawn.effectiveModel,
    );
    const runtimeArgs = resolveDelegationRuntimeArgs(provider, effectiveOptions);
    const spawnArgs = [...spawn.args, ...runtimeArgs];
    log.info({
      call_name: def.call_name,
      template_id: def.template_id,
      provider,
      cwd,
      branch: spawnBranch,
      worktree_path: spawnWorktreePath,
      worktree_created: spawnWorktreeCreated,
      worktree_state: spawnWorktreeState,
      project: def.project ?? null,
      caller_cwd: input.cwd ?? null,
      template_default_cwd: def.default_cwd ?? null,
      triggered_by: input.triggered_by ?? null,
      option_keys: Object.keys(effectiveOptions),
      effort_level: effortLevel,
      effort_source: effortSource,
      effort_bucket: effortBucket,
      effort_decision_id: effortDecisionId,
      effort_confidence: effortConfidence,
    }, "delegation invoke received");

    // 1) write prompt to file (run id は invoke 側で確保済み = file 名 == 行 id)
    // 起動セッションは Concordia 協調セッションなので、 文脈説明を
    // 初期プロンプト冒頭に注入する (spec/delegation.md §4)。
    // kind 別 Inject マニュアル (inject_manuals) をテンプレから解決して差し込む。
    const manualKind = resolveManualKind({ call_name: def.call_name, title: def.title, category: def.category });
    const manualContent = this.deps.injectManual?.(manualKind) ?? null;
    // パートタイマーは実装委託と別書式で渡す。 タスク本文を先頭にそのまま置き、
    // Concordia が足すのは「本文が全文」「迷っても止まらない」「終わり方」の 3 点だけ。
    // 経緯は delegation/parttimer-inject.ts 冒頭 (2026-09-03 neco 指示)。
    const isParttimer = def.category === "parttimer";
    // Genius command-pattern (定型作業のコマンド列) を task 文面で照会して差し込む。
    // Genius 不在・不一致・失敗は注入なしで委託を続行する (fail-soft)。
    // パートタイマーは対象外 — 本文が手順まで書き切っている定時作業なので、 一致しない
    // 手順ブロックを push すると「本文が全文」という前提を崩す。
    let commandPatternBlock: string | null = null;
    if (!isParttimer && this.deps.commandPatterns) {
      try {
        commandPatternBlock = await this.deps.commandPatterns(renderedPrompt);
      } catch {
        // Command patterns are advisory; Genius failure must not block delegation launch.
      }
    }
    // パートタイマーの協調文脈は parttimer-inject が本文内に必要分だけ持つので、
    // 前置きの Concordia コンテキストは載せない。
    const contextBlock = isParttimer ? "" : buildDelegationContext(
      this.deps.concordiaUrl,
      manualContent ? { kind: manualKind, content: manualContent } : null,
      commandPatternBlock,
      typeof effectiveOptions.team === "string" ? this.deps.teamRules?.(effectiveOptions.team) ?? null : null,
      typeof effectiveOptions.team === "string" ? this.deps.teamPrRules?.(effectiveOptions.team) ?? null : null,
    );
    // 実装委託は 1 通で全部渡す (段階注入は 2026-08-21 に廃止)。 why + タスク本文 +
    // Memoria タスク + 完了条件を初回 inject に載せ、 調査は委託先が Anatomia で自走する。
    // spec/feature/delegation-implementation-inject.md。
    let memoriaLink: MemoriaTaskLink | null = null;
    let promptSection = renderedPrompt;
    let bundledDocs: string[] = [];
    // Augur CLI は PATH に居ない。 端末ごとに違う絶対パスなので実行時に解決し、
    // 解決できた場合だけ集計コマンドを本文へ載せる。
    const augurCliPath = resolveAugurCliPath({
      env: process.env,
      workspaceRoots: this.deps.workspaceRoots?.() ?? [],
    });
    if (isParttimer) {
      promptSection = buildParttimerInject({
        runId,
        title: def.title,
        task: renderedPrompt,
        concordiaUrl: this.deps.concordiaUrl ?? "http://127.0.0.1:11111",
        mentionUserId: this.deps.mentionUserId?.() ?? null,
        cwd: cwd ?? null,
        manual: manualContent,
      });
    } else if (manualKind === IMPLEMENTATION_MANUAL_KIND) {
      const why = resolveWhy({ args: input.args ?? {}, title: def.title });
      const memoria = await createDelegationMemoriaTask(
        this.deps.memoria?.() ?? null,
        buildMemoriaTaskDraft({
          runId,
          callName: def.call_name,
          title: def.title,
          task: renderedPrompt,
          why,
          repoPath: cwd ?? null,
        }),
        runId,
      );
      memoriaLink = memoria.link;
      promptSection = buildImplementationInject({
        runId,
        title: def.title,
        task: renderedPrompt,
        why,
        memoria: memoria.link,
        memoriaError: memoria.error,
        repoPath: cwd ?? null,
        branch: spawnBranch,
        concordiaUrl: this.deps.concordiaUrl ?? "http://127.0.0.1:11111",
        augurCli: augurCliPath ? augurCliCommand(augurCliPath) : null,
      });
    }
    // 別リポの正本はパスを書いても子は読めない (cwd の外)。 明示された参照だけ本文を
    // 同梱する (spec/feature/task-workflow.md §3.2)。 パートタイマーは本文が全文なので対象外。
    if (!isParttimer) {
      const bundle = buildExternalDocBundle({
        refs: collectExternalDocRefs({ args: input.args ?? null, memoryLinks: input.memory_links ?? null }),
        spawnCwd: cwd ?? null,
        spawnRepoPath: cwd ? this.deps.resolveRepoForPath?.(cwd)?.repo_path ?? null : null,
        repos: this.deps.registeredRepos?.() ?? [],
      });
      if (bundle.section) {
        promptSection = `${promptSection}

${bundle.section}`;
        bundledDocs = bundle.labels;
        log.info({ run_id: runId, bundled_docs: bundle.labels, skipped: bundle.skipped.length }, "delegation bundled external docs");
      }
    }
    try {
      await mkdir(this.promptsDir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `failed to create prompts dir: ${(err as Error).message}` };
    }
    const promptPath = join(this.promptsDir, `${runId}.md`);
    const promptBody = isParttimer
      ? renderParttimerPromptFile(def, promptSection, runId, provider, spawn.effectiveModel)
      : renderPromptFile(
        def,
        promptSection,
        input.args ?? {},
        effectiveOptions,
        runId,
        contextBlock,
        provider,
        spawn.effectiveModel,
        { runId, cwd: cwd ?? null, branch: spawnBranch, concordiaUrl: this.deps.concordiaUrl ?? null },
      );
    try {
      await writeFile(promptPath, promptBody, "utf8");
    } catch (err) {
      return { ok: false, error: `failed to write prompt file: ${(err as Error).message}` };
    }

    // 2) spawn (optional)
    let spawnPid: number | null = null;
    let spawnCommand: string[] | null = null;
    let status: DelegationRunRow["status"] = "pending";
    let spawnError: string | null = null;
    if (shouldSpawn) {
      const result = launchDelegationProcess({
        runId,
        definition: def,
        invocation: input,
        logicalProvider: provider,
        spawnProvider: spawn.provider,
        spawnArgs,
        spawnEnv: spawn.env,
        effectiveModel: spawn.effectiveModel,
        effectiveOptions,
        cwd,
        branch: spawnBranch,
        promptPath,
        // Discord surface / 再送に写るのも第1段階の本文。 伏せたタスク本文をここから
        // 漏らすと段階注入の意味が無くなる。
        startupInjectText: promptSection,
        startedAt: new Date(startedAt).toISOString(),
        spawner: this.deps.spawn as DelegationSpawner | undefined,
      });
      spawnPid = result.spawnPid;
      spawnCommand = result.spawnCommand;
      status = result.status;
      spawnError = result.error;
    } else {
      log.info({ run_id: runId, call_name: input.call_name }, "delegation render-only (spawn=false)");
    }

    return {
      ok: true,
      provider,
      status,
      spawn_pid: spawnPid,
      spawn_command: spawnCommand,
      error_message: spawnError,
      cwd: cwd ?? null,
      branch: spawnBranch,
      worktree_path: spawnWorktreePath,
      worktree_created: spawnWorktreeCreated,
      worktree_state: spawnWorktreeState,
      effort_level: effortLevel,
      effort_source: effortSource,
      effort_bucket: effortBucket,
      effective_model: spawn.effectiveModel,
      fast_mode: effectiveOptions.fast_mode === true,
      effort_decision_id: effortDecisionId,
      memoria_task: memoriaLink,
      bundled_docs: bundledDocs,
    };
  }
}

function normalizeInvocationPaths(input: InvokeInput): InvokeInput {
  const cwd = typeof input.cwd === "string"
    ? recoverCollapsedWindowsWorkspacePath(input.cwd)
    : input.cwd;
  const targetRepo = input.args?.target_repo;
  if (typeof targetRepo !== "string") {
    return cwd === input.cwd ? input : { ...input, cwd };
  }
  const recoveredTargetRepo = recoverCollapsedWindowsWorkspacePath(targetRepo);
  if (cwd === input.cwd && recoveredTargetRepo === targetRepo) return input;
  return {
    ...input,
    cwd,
    args: { ...input.args, target_repo: recoveredTargetRepo },
  };
}

type ExplicitEffortSource = "override" | "one-shot" | "template";

function findRequestedEffort(
  provider: DelegationProvider,
  templateOptions: DelegationRuntimeOptions,
  oneShotOptions: DelegationRuntimeOptions,
  overrides: InvokeInput["overrides"],
): { value: unknown; source: ExplicitEffortSource } | null {
  if (overrides?.reasoning_effort !== undefined) {
    return { value: overrides.reasoning_effort, source: "override" };
  }
  const keys = isCodexFamilyProvider(provider)
    ? ["model_reasoning_effort", "reasoning_effort", "effort"]
    : ["effort", "reasoning_effort"];
  for (const key of keys) {
    if (oneShotOptions[key] !== undefined) return { value: oneShotOptions[key], source: "one-shot" };
  }
  for (const key of keys) {
    if (templateOptions[key] !== undefined) return { value: templateOptions[key], source: "template" };
  }
  return null;
}

function isAutoEffort(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "auto";
}

function renderPromptFile(
  def: DelegationDefinition,
  rendered: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  runId: string,
  contextBlock: string,
  targetProvider: DelegationProvider,
  effectiveModel: string | null,
  commit: CommitBrokerHint,
): string {
  const argsBlock = Object.keys(args).length === 0
    ? "(none)"
    : Object.entries(args).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n");
  const optionsBlock = Object.keys(options).length === 0
    ? "(none)"
    : Object.entries(options).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n");
  return [
    `# Delegation: ${def.call_name}`,
    "",
    `- run_id: ${runId}`,
    `- target_provider: ${targetProvider}`,
    `- model: ${effectiveModel ?? def.model ?? "(provider default)"}`,
    `- project: ${def.project?.trim() || "(none)"}`,
    `- template_title: ${def.title}`,
    "",
    // Concordia 文脈 (起動後の振る舞い指示を含む)。
    contextBlock,
    "## Args",
    "",
    argsBlock,
    "",
    "## Runtime Options",
    "",
    optionsBlock,
    "",
    "## Prompt",
    "",
    rendered,
    "",
    renderCommitSection(commit),
  ].join("\n");
}

/**
 * パートタイマーの prompt file。 タスク本文 (parttimer-inject 済み) をそのまま先頭に置き、
 * run のメタ情報だけ末尾へ回す。 Args / Runtime Options 節は作らない — args は本文へ
 * 変数展開済みで、 重ねて並べるとタスクが下へ押し出されるだけだった。
 * コミット代行の案内も載せない (本文が変更を指示していなければコミットは発生しない)。
 */
function renderParttimerPromptFile(
  def: DelegationDefinition,
  body: string,
  runId: string,
  targetProvider: DelegationProvider,
  effectiveModel: string | null,
): string {
  return [
    body.trimEnd(),
    "",
    "---",
    "",
    `run: ${def.call_name} / run_id: ${runId} / provider: ${targetProvider}` +
      ` / model: ${effectiveModel ?? def.model ?? "(provider default)"}` +
      ` / project: ${def.project?.trim() || "(none)"}`,
    "",
  ].join("\n");
}

interface CommitBrokerHint {
  runId: string;
  cwd: string | null;
  branch: string | null;
  concordiaUrl: string | null;
}

/**
 * コミット代行の使い方。 sandbox 下の委託先 (Codex の workspace-write 等) は `.git` に
 * 書けず、 実装が済んでいてもコミットできずに run が落ちる。 そこで依頼を出す口を
 * 毎回プロンプトに載せる — 知らなければ仕組みは使われない。
 */
function renderCommitSection(commit: CommitBrokerHint): string {
  if (!commit.cwd) return "";
  const endpoint = commit.concordiaUrl
    ? `${commit.concordiaUrl.replace(/\/$/, "")}/v1/delegation/runs/${commit.runId}/commit`
    : `/v1/delegation/runs/${commit.runId}/commit`;
  return [
    "## コミット (自分で git commit しなくてよい)",
    "",
    "`.git` への書き込みが sandbox で拒否される環境がある。 実装が終わったら",
    "**自分でコミットせず Concordia に依頼する**こと。 どちらか片方でよい:",
    "",
    `1. cwd 直下に \`.concordia-commit.json\` を置く (ファイル書き込みは必ず通る):`,
    "",
    '   { "message": "feat(scope): 要約", "paths": ["省略可 / 省略時は全変更"] }',
    "",
    `2. loopback が使えるなら \`POST ${endpoint}\` に同じ JSON を送る (即時)`,
    "",
    `対象は run が所有する worktree のみ (cwd: ${commit.cwd}` +
      `${commit.branch ? `, branch: ${commit.branch}` : ""})。`,
    "main / master への直接コミット、 worktree 外の stage、 200 ファイル超の変更は拒否される。",
    "push はしない (公開はローカル PR 経路の責務)。",
    "",
  ].join("\n");
}
