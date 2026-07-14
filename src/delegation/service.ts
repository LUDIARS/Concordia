/**
 * Delegation service: テンプレ render + invoke (spawn 連携 + 記録).
 *
 * spec/delegation.md §3-4.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  type DelegationRepo,
  type DelegationProvider,
  type DelegationRunRow,
  type DelegationTemplateRow,
  type InputSchemaItem,
  parseRuntimeOptions,
  parseInputSchema,
} from "../db/delegation-repo.js";
import { spawnSession, type SpawnRequest } from "../control/spawner.js";
import { spawnCodexExecWorker } from "../control/codex-worker-spawn.js";
import {
  forgetPendingDelegationSpawnByRunId,
  recordPendingDelegationSpawn,
} from "../control/pending-delegation-spawns.js";
import {
  resolveEffectiveDelegationRuntimeOptions,
  resolveDelegationRuntimeArgs,
  resolveDelegationRuntimeEnv,
  resolveDelegationSpawn,
  goalAndGoRequested,
  type DelegationRuntimeOptions,
} from "../control/provider-preset.js";
import { prepareSpawnTarget } from "../control/spawn-target.js";
import { resolveLocalModel } from "../control/famulus-select.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import { buildDelegationContext } from "./persona-context.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("delegation/service");

/// 静的文字列内の `${var}` を args から埋める (fallback 構文 `${var:fb}` 対応)。
/// renderTemplate と違って schema チェックや missing 追跡はしない (cwd 用)。
/// app.ts の spawn-from-template (素のセッション) 経路も同じ展開を使うため export。
export function substituteVars(s: string, args: Record<string, unknown>): string {
  return s.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}/g,
    (_m, name: string, fb?: string) => {
      const v = args[name];
      if (v !== undefined && v !== null && v !== "") return String(v);
      return fb ?? "";
    });
}

export interface RenderResult {
  rendered: string;
  missing: string[];     // required but absent
  unknown_vars: string[]; // referenced in template but not in schema (warning)
}

const VAR_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}/g;

export function renderTemplate(
  template: string,
  args: Record<string, unknown>,
  schema: InputSchemaItem[],
): RenderResult {
  const missing: string[] = [];
  const unknown: Set<string> = new Set();
  const required = new Set(schema.filter((s) => s.required).map((s) => s.name));
  const known = new Set(schema.map((s) => s.name));
  // First fill in defaults from schema for any missing args
  const filledArgs: Record<string, unknown> = { ...args };
  for (const s of schema) {
    if (filledArgs[s.name] === undefined && s.default !== undefined) {
      filledArgs[s.name] = s.default;
    }
  }
  // Required check
  for (const r of required) {
    const v = filledArgs[r];
    if (v === undefined || v === null || v === "") missing.push(r);
  }
  const rendered = template.replace(VAR_RE, (_match, name: string, fallback?: string) => {
    if (!known.has(name)) unknown.add(name);
    const v = filledArgs[name];
    if (v !== undefined && v !== null && v !== "") return String(v);
    return fallback ?? "";
  });
  return { rendered, missing, unknown_vars: Array.from(unknown) };
}

export function validateArgs(
  args: Record<string, unknown>,
  schema: InputSchemaItem[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const s of schema) {
    const v = args[s.name];
    if (v === undefined || v === null) {
      if (s.required && s.default === undefined) {
        errors.push(`missing required arg: ${s.name}`);
      }
      continue;
    }
    const t = typeof v;
    if (s.type === "string" && t !== "string") errors.push(`arg ${s.name} must be string`);
    if (s.type === "number" && t !== "number") errors.push(`arg ${s.name} must be number`);
    if (s.type === "boolean" && t !== "boolean") errors.push(`arg ${s.name} must be boolean`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * 起動に必要な delegation 定義の最小集合。 グローバルテンプレ (delegation_templates) と
 * 子会社所有の複製 (subsidiary_delegations) を同じ起動経路 (runDefinition) に載せるための共通形。
 */
export interface DelegationDefinition {
  /** run 記録の template_id。 グローバルテンプレなら id、 子会社所有 (テンプレ無し) なら null。 */
  template_id: string | null;
  call_name: string;
  title: string;
  target_provider: DelegationProvider;
  model: string | null;
  runtime_options_json?: string | null;
  prompt_template: string;
  input_schema: string;          // JSON string
  default_cwd: string | null;
  project?: string | null;
  emoji?: string | null;
}

/** グローバルテンプレ行を起動定義に変換する。 */
export function templateToDefinition(tpl: DelegationTemplateRow): DelegationDefinition {
  return {
    template_id: tpl.id,
    call_name: tpl.call_name,
    title: tpl.title,
    target_provider: tpl.target_provider as DelegationProvider,
    model: tpl.model,
    runtime_options_json: tpl.runtime_options_json,
    prompt_template: tpl.prompt_template,
    input_schema: tpl.input_schema,
    default_cwd: tpl.default_cwd,
    project: tpl.project,
    emoji: tpl.emoji,
  };
}

export interface InvokeInput {
  call_name: string;
  args: Record<string, unknown>;
  cwd?: string;
  /** render 後の prompt 末尾に追記する任意の追加指示（テンプレ render とは別経路）。 */
  extra_prompt?: string;
  /** prompt 末尾にリンクとして列挙する参照メモリ。内容は読み込まない。 */
  memory_links?: string[];
  triggered_by?: string;
  /** false で spawn せず render + 記録のみ */
  spawn?: boolean;
  /** Provider-specific one-shot options. These are not stored on the template. */
  options?: DelegationRuntimeOptions;
  /** One-shot provider/model/runtime overrides. These are not stored on the template. */
  overrides?: {
    provider?: DelegationProvider;
    model?: string | null;
    reasoning_effort?: string;
  };
  /** Active parent Concordia session that requested this delegation, when known. */
  parent_session_id?: string | null;
  /** Optional git branch for the spawned session. Worktree mode avoids switching the current checkout. */
  branch?: string;
  /** When branch is set, defaults to true: create/reuse a linked worktree for the branch. */
  worktree?: boolean;
  /** 子会社由来の invoke なら子会社 id。 spawn したセッションの metadata.subsidiary_id へ焼く。 */
  subsidiary_id?: string | null;
  /** project 限定 spawn なら session.started 時に metadata.project へ焼く。 */
  project?: string | null;
}

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
interface QueuePayload {
  def: DelegationDefinition;
  input: InvokeInput;
}

export interface InvokeResultErr {
  ok: false;
  error: string;
  details?: unknown;
}

export type InvokeResult = InvokeResultOk | InvokeResultErr;

export interface DelegationServiceDeps {
  repo: DelegationRepo;
  /** 端末 spawn を上書き (テスト用)。 省略時は実際に wt.exe を起動 */
  spawn?: (req: SpawnRequest) => { ok: true; pid: number | null; command: string[] } | { ok: false; error: string };
  /** prompt file の出力先 dir (default = process.cwd()/delegation-prompts) */
  promptsDir?: string;
  /** persona 注入用 (省略時は persona ブロックを付けない)。 */
  personas?: PersonasRepo;
  /** delegation context に載せる協調 API URL。 */
  concordiaUrl?: string;
  /** persona 選択の rng 上書き (テスト用)。 */
  rng?: () => number;
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
  writeAdHocPrompt(prompt: string): string {
    mkdirSync(this.promptsDir, { recursive: true });
    const path = join(this.promptsDir, `${randomUUID()}.md`);
    writeFileSync(path, prompt, "utf8");
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
    const schema = parseInputSchema(def.input_schema);
    const validation = validateArgs(input.args ?? {}, schema);
    if (!validation.ok) {
      return { ok: false, error: "invalid args", details: validation.errors };
    }
    const render = renderTemplate(def.prompt_template, input.args ?? {}, schema);
    if (render.missing.length > 0) {
      return { ok: false, error: "missing required args", details: render.missing };
    }
    // 初回注入プロンプト (任意) を render 結果の末尾に追記する。テンプレ render とは
    // 別経路で、 人間が起動時に渡す追加指示。 prompt file + run.rendered_prompt 両方に載る。
    const extra = (input.extra_prompt ?? "").trim();
    const withExtra = extra
      ? `${render.rendered}\n\n---\n\n## 追加の初回指示（人間）\n\n${extra}`
      : render.rendered;
    const memoryLinks = (input.memory_links ?? []).map((link) => link.trim()).filter(Boolean);
    const renderedPrompt = memoryLinks.length > 0
      ? `${withExtra}\n\n## 参照メモリ (必要な分だけ読むこと)\n\n${memoryLinks.map((link) => `- ${link}`).join("\n")}`
      : withExtra;
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
    if (!run.queue_payload_json) {
      this.deps.repo.markRunSpawned(run.id, {
        status: "spawn_failed", spawn_pid: null, spawn_command: null,
        error: "queue payload missing (起動入力が失われているため再実行できません)",
      });
      return;
    }
    let payload: QueuePayload;
    try {
      payload = JSON.parse(run.queue_payload_json) as QueuePayload;
    } catch (e) {
      this.deps.repo.markRunSpawned(run.id, {
        status: "spawn_failed", spawn_pid: null, spawn_command: null,
        error: `queue payload broken: ${(e as Error).message}`,
      });
      return;
    }
    const launch = await this.launch(run.id, payload.def, payload.input, run.rendered_prompt, true);
    if (!launch.ok) {
      this.deps.repo.markRunSpawned(run.id, {
        status: "spawn_failed", spawn_pid: null, spawn_command: null, error: launch.error,
      });
      return;
    }
    this.deps.repo.markRunSpawned(run.id, {
      status: launch.status,
      spawn_pid: launch.spawn_pid,
      spawn_command: launch.spawn_command,
      error: launch.error_message,
    });
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
    const effectiveOptions = resolveEffectiveDelegationRuntimeOptions(
      provider,
      {
        ...parseRuntimeOptions(def.runtime_options_json),
        ...(input.options ?? {}),
        ...(input.overrides?.reasoning_effort ? { reasoning_effort: input.overrides.reasoning_effort } : {}),
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
    }, "delegation invoke received");

    // 1) write prompt to file (run id は invoke 側で確保済み = file 名 == 行 id)
    // 起動セッションは Concordia 協調セッションなので、 文脈説明 + 暫定 persona 全文を
    // 初期プロンプト冒頭に注入する (spec/delegation.md §4)。
    const persona = this.deps.personas?.pickForDelegation(this.deps.rng) ?? null;
    const contextBlock = buildDelegationContext(persona, this.deps.concordiaUrl);
    mkdirSync(this.promptsDir, { recursive: true });
    const promptPath = join(this.promptsDir, `${runId}.md`);
    const promptBody = renderPromptFile(
      def,
      renderedPrompt,
      input.args ?? {},
      effectiveOptions,
      runId,
      contextBlock,
      persona?.name ?? null,
      provider,
      spawn.effectiveModel,
    );
    try {
      writeFileSync(promptPath, promptBody, "utf8");
    } catch (err) {
      return { ok: false, error: `failed to write prompt file: ${(err as Error).message}` };
    }

    // 2) spawn (optional)
    let spawnPid: number | null = null;
    let spawnCommand: string[] | null = null;
    let status: DelegationRunRow["status"] = "pending";
    let spawnError: string | null = null;
    if (shouldSpawn) {
      // Codex 委託は対話 TUI (wt.exe→Lictor) をやめ headless `codex exec` worker で走らせる
      // (trust/approval プロンプトで詰まらせない)。 それ以外は従来の wt.exe spawn。
      const spawner =
        this.deps.spawn ??
        ((req) => (req.provider === "codex" ? spawnCodexExecWorker(req) : spawnSession(req)));
      const req: SpawnRequest = {
        // 実 spawn は解決後の CLI。 gemma4-12 は Lictor ネイティブ local-agent
        // (`lictor gemma4-12`)、 それ以外は同名 CLI。 記録上の論理 provider とは別。
        provider: spawn.provider,
        mode: "window",
        cwd: cwd ?? undefined,
        // 解決済み args (`--model` 等)。 空配列なら付けず、 各 CLI の config 既定に委ねる。
        args: spawnArgs.length > 0 ? spawnArgs : undefined,
        title: `delegation:${input.call_name}`,
        env: {
          // spawn 解決由来の env (gemma4-12 の LICTOR_LOCAL_MODEL 等) を先に展開。
          ...(spawn.env ?? {}),
          ...resolveDelegationRuntimeEnv(provider, effectiveOptions),
          CONCORDIA_DELEGATION_PROMPT_FILE: promptPath,
          CONCORDIA_DELEGATION_RUN_ID: runId,
          ...(input.parent_session_id ? {
            CONCORDIA_DELEGATION_PARENT_SESSION_ID: input.parent_session_id,
            CONCORDIA_PARENT_SESSION_ID: input.parent_session_id,
          } : {}),
          CONCORDIA_DELEGATION_CALL_NAME: input.call_name,
        },
      };
      // Register before spawn so a fast session.started callback can claim this run.
      recordPendingDelegationSpawn({
        cwd,
        emoji: def.emoji ?? null,
        callName: input.call_name,
        runId,
        subsidiaryId: input.subsidiary_id ?? null,
        project: input.project ?? null,
        parentSessionId: input.parent_session_id ?? null,
        goalAndGo: goalAndGoRequested(effectiveOptions),
      });
      const result = spawner(req);
      if (result.ok) {
        spawnPid = result.pid;
        spawnCommand = result.command;
        status = "spawned";
        log.info({
          run_id: runId, call_name: input.call_name, provider, cwd,
          spawn_pid: spawnPid, prompt_file: promptPath,
        }, "delegation spawn ok");
      } else {
        forgetPendingDelegationSpawnByRunId(runId);
        status = "spawn_failed";
        spawnError = result.error;
        log.warn({
          run_id: runId, call_name: input.call_name, provider, cwd,
          error: spawnError,
        }, "delegation spawn failed");
      }
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
    };
  }
}

/** launch (副作用フェーズ) の結果。 ok:false は run 行を作る前に落ちたケース。 */
type LaunchResult =
  | {
      ok: true;
      provider: DelegationProvider;
      status: DelegationRunRow["status"];
      spawn_pid: number | null;
      spawn_command: string[] | null;
      error_message: string | null;
      cwd: string | null;
      branch: string | null;
      worktree_path: string | null;
      worktree_created: boolean;
    }
  | { ok: false; error: string };

function renderPromptFile(
  def: DelegationDefinition,
  rendered: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  runId: string,
  contextBlock: string,
  personaName: string | null,
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
    `- persona: ${personaName ?? "(none)"}`,
    `- template_title: ${def.title}`,
    "",
    // Concordia 文脈 + 暫定 persona 全文 (起動後の振る舞い指示を含む)。
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
