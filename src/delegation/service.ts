/**
 * Delegation service: テンプレ render + invoke (spawn 連携 + 記録).
 *
 * spec/delegation.md §3-4.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  type DelegationRepo,
  type DelegationProvider,
  type DelegationRunRow,
  parseRuntimeOptions,
} from "../db/delegation-repo.js";
import {
  isCodexFamilyProvider,
  resolveEffectiveDelegationRuntimeOptions,
  resolveDelegationRuntimeArgs,
  resolveDelegationSpawn,
  normalizeProviderEffort,
  type DelegationRuntimeOptions,
} from "../control/provider-preset.js";
import { prepareSpawnTarget } from "../control/spawn-target.js";
import { resolveLocalModel } from "../control/famulus-select.js";
import { buildDelegationContext } from "./persona-context.js";
import { resolveManualKind } from "./manual-kind.js";
import { createChildLogger } from "../shared/logger.js";
import {
  baselineEffort,
  classifyTaskEffort,
  supportsAutomaticEffort,
  type EffortTaskBucket,
} from "./effort-policy.js";
import type { DelegationEffortBlackbox } from "./effort-blackbox.js";
import { buildInvocationPlan } from "./plan.js";
import { recoverCollapsedWindowsWorkspacePath } from "./windows-path-recovery.js";
import { substituteVars } from "./prompt.js";
import {
  templateToDefinition,
  type DelegationDefinition,
  type InvokeInput,
  type QueuePayload,
  type LaunchResult,
} from "./contracts.js";
import { executeQueuedRun } from "./executor.js";
import { launchDelegationProcess, type DelegationSpawner } from "./launcher.js";
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
  /** Growth blackbox used for provider-independent effort selection. */
  effortBlackbox?: DelegationEffortBlackbox;
  /**
   * kind 別 Inject マニュアルの解決 (inject_manuals から引く)。 未注入なら差し込まない。
   * kind は resolveManualKind (manual-kind.ts) がテンプレから解決する。
   */
  injectManual?: (kind: string) => string | null;
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
    if (!tpl.is_active) return { ok: false, error: `template is inactive: ${input.call_name}` };
    return this.runDefinition(templateToDefinition(tpl), input);
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
    const plan = buildInvocationPlan(def, input);
    if (!plan.ok) return plan;
    const renderedPrompt = plan.renderedPrompt;
    const runId = randomUUID();
    const promptPath = join(this.promptsDir, `${runId}.md`);
    const shouldSpawn = input.spawn !== false;

    // 同時実行上限に達していれば spawn せずキューに入れる。 worktree 作成・prompt file
    // 書き出しといった副作用は起動時 (launch) までまとめて遅延させる — 待たせている間に
    // worktree だけ先に生えている、 という中途半端な状態を作らないため。
    if (shouldSpawn && this.queue?.enabled() && !this.queue.hasCapacity()) {
      const payload: QueuePayload = { def, input };
      const run = this.deps.repo.createRun({
        id: runId,
        template_id: def.template_id,
        call_name: def.call_name,
        target_provider: input.overrides?.provider ?? def.target_provider,
        parent_session_id: input.parent_session_id ?? null,
        args: input.args ?? {},
        rendered_prompt: renderedPrompt,
        prompt_file_path: promptPath,
        spawn_pid: null,
        spawn_command: null,
        triggered_by: input.triggered_by ?? null,
        status: "queued",
        queue_payload_json: JSON.stringify(payload),
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
        queued: true,
        queue_position: position,
      };
    }

    const launch = await this.launch(runId, def, input, renderedPrompt, shouldSpawn);
    if (!launch.ok) return { ok: false, error: launch.error };

    const run = this.deps.repo.createRun({
      id: runId,
      template_id: def.template_id,
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
      effort_decision_id: launch.effort_decision_id,
    });

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
      queued: false,
      queue_position: null,
    };
  }

  /**
   * キュー待ちだった run を起動する (DelegationQueue から呼ばれる)。 payload から
   * 起動入力を復元し、 invoke 時と同じ launch を通してから run に結果を焼き戻す。
   */
  async spawnQueuedRun(run: DelegationRunRow): Promise<void> {
    await executeQueuedRun({
      run,
      repo: this.deps.repo,
      launch: (payload) => this.launch(run.id, payload.def, payload.input, run.rendered_prompt, true),
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
  ): Promise<LaunchResult> {
    const provider = input.overrides?.provider ?? def.target_provider;
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
    }
    // local-LLM レーン (gemma4-12、旧 gamma) で model="auto" のとき、Famulus の黒箱
    // 切り替え機にモデルを選ばせる。選択の Sonnet ワンショットは Famulus 内部なので
    // Concordia は LLM-free を維持 (`famulus select` を shell するだけ)。それ以外は素通し。
    // project ヒントは delegation の project を最優先、 無ければ cwd の basename。
    let modelInput = input.overrides?.model !== undefined ? input.overrides.model : def.model;
    if (provider === "gemma4-12" && (modelInput ?? "").trim().toLowerCase() === "auto") {
      const projectHint = (def.project ?? "").trim() || (cwd ? basename(cwd) : undefined);
      modelInput = await resolveLocalModel(modelInput, { project: projectHint, repo: cwd ?? null });
      log.info({ call_name: def.call_name, project: projectHint, resolved_model: modelInput }, "famulus auto-model resolved");
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
    if (supportsAutomaticEffort(provider)) {
      effortBucket = classifyTaskEffort(renderedPrompt);
      if (requestedEffort && !isAutoEffort(requestedEffort.value)) {
        const normalized = normalizeProviderEffort(provider, requestedEffort.value);
        if (!normalized) {
          return { ok: false, error: `invalid ${provider} effort: ${String(requestedEffort.value)}` };
        }
        effortLevel = normalized;
        effortSource = requestedEffort.source;
      } else {
        const decision = this.deps.effortBlackbox && shouldSpawn
          ? await this.deps.effortBlackbox.decide({
              provider,
              model: spawn.effectiveModel,
              prompt: renderedPrompt,
              callName: def.call_name,
              project: def.project ?? null,
            })
          : {
              level: baselineEffort(effortBucket),
              bucket: effortBucket,
              source: "auto-baseline" as const,
              decision_id: null,
              confidence: null,
            };
        effortLevel = decision.level;
        effortSource = decision.source;
        effortDecisionId = decision.decision_id;
        effortConfidence = decision.confidence;
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
    const manualKind = resolveManualKind({ call_name: def.call_name, title: def.title });
    const manualContent = this.deps.injectManual?.(manualKind) ?? null;
    const contextBlock = buildDelegationContext(
      this.deps.concordiaUrl,
      manualContent ? { kind: manualKind, content: manualContent } : null,
    );
    try {
      await mkdir(this.promptsDir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `failed to create prompts dir: ${(err as Error).message}` };
    }
    const promptPath = join(this.promptsDir, `${runId}.md`);
    const promptBody = renderPromptFile(
      def,
      renderedPrompt,
      input.args ?? {},
      effectiveOptions,
      runId,
      contextBlock,
      provider,
      spawn.effectiveModel,
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
        effectiveOptions,
        cwd,
        branch: spawnBranch,
        promptPath,
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
      effort_level: effortLevel,
      effort_source: effortSource,
      effort_bucket: effortBucket,
      effective_model: spawn.effectiveModel,
      fast_mode: effectiveOptions.fast_mode === true,
      effort_decision_id: effortDecisionId,
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
  ].join("\n");
}
