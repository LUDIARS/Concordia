/**
 * Delegation の論理 provider → 実 spawn (CLI + args) 解決。
 *
 * delegation_templates.target_provider は「論理プリセット」で、 Lictor が実際に
 * 包む CLI (= SpawnProvider: claude/codex/gemini) とは必ずしも 1:1 でない。
 *
 * 特に **gemma4-12** は「ローカル LLM 委託レーン」で、 Lictor のネイティブ local-agent
 * (`lictor gemma4-12` = Ollama を直接叩く軽量 REPL) を spawn する。 推論は Ollama 上の
 * ローカルモデル (既定 Gemma 4 12B)。 **codex CLI ではラップしない** (旧 v0.3 は
 * `codex --oss` を使っていたが、 Lictor にネイティブ local provider が出来たので廃止)。
 * モデルは `LICTOR_LOCAL_MODEL` 環境変数で Lictor 側へ渡す。
 *
 * 旧名は `gamma`。 後方互換のため resolveDelegationSpawn は永続化済みの `gamma`
 * も受理する (DB の target_provider に "gamma" が残っていても解決できる)。
 *
 * この解決を 1 箇所に集約し、 delegation invoke (service.ts) と
 * admin spawn-from-template (app.ts) の両経路が同じ写像を使う。
 */

import type { SpawnProvider } from "./spawner.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("control/provider-preset");

interface ProviderPresetLog {
  warn(bindings: Record<string, unknown>, message: string): void;
}

/** gemma4-12 の論理 provider 名。 旧名は `gamma` (後方互換エイリアス)。 */
export const LOCAL_LLM_PROVIDER = "gemma4-12";

/** gemma4-12 が既定で使うローカルモデル (Ollama タグ)。 template.model 未指定時。 */
export const GEMMA4_12_DEFAULT_MODEL = "gemma4:12b";

/**
 * gemma4-12 の実 spawn 先。 Lictor のネイティブ local provider をそのまま起動する
 * (= `lictor gemma4-12`)。 codex CLI は経由しない。
 */
const GEMMA4_12_SPAWN_PROVIDER: SpawnProvider = "gemma4-12";

/** UI / プロンプトヘッダ向けの表示ラベル。 */
export const DELEGATION_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude (Claude Code)",
  codex: "Codex (OpenAI)",
  "codex-sdk": "Codex SDK (Satelles headless)",
  gemini: "Gemini",
  "gemma4-12": "gemma4-12 (ローカル LLM / Ollama)",
};

export interface ResolvedSpawn {
  /** 実際に lictor が wrap する CLI (= `lictor <provider>`)。 */
  provider: SpawnProvider;
  /** CLI に渡す追加 args (`--model` 等)。 空配列なら付けない。 */
  args: string[];
  /** プロンプトヘッダ等に出す「実効モデル」。 gemma4-12 は既定を解決した値。 */
  effectiveModel: string | null;
  /**
   * spawn 時に追加で渡す環境変数。 gemma4-12 は `LICTOR_LOCAL_MODEL` で Lictor の
   * local-agent にモデルを渡す (CLI フラグではなく env 経由)。 caller は spawn req の
   * env にマージする。 未指定なら何も足さない。
   */
  env?: Record<string, string>;
}

export interface DelegationOptionChoice {
  label: string;
  value: string;
  description?: string;
}

export interface DelegationOptionSuggestion {
  key: string;
  label: string;
  type: "select" | "string" | "boolean" | "number";
  description?: string;
  choices?: DelegationOptionChoice[];
}

export type DelegationRuntimeOptions = Record<string, unknown>;

export const CODEX_DEFAULT_REASONING_EFFORT = "xhigh";
export const CLAUDE_OPUS_DEFAULT_EFFORT = "medium";

const CODEX_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "ultra"]);
const CLAUDE_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CODEX_CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function delegationOptionSuggestions(provider: string, model?: string | null): DelegationOptionSuggestion[] {
  const suggestions: DelegationOptionSuggestion[] = [];
  if (isCodexFamilyProvider(provider) && supportsCodexReasoningEffort(model)) {
    const choices: DelegationOptionChoice[] = [
      { label: "auto (learned)", value: "auto" },
      { label: "minimal", value: "minimal" },
      { label: "low", value: "low" },
      { label: "medium", value: "medium" },
      { label: "high", value: "high" },
      { label: "xhigh (Extra High)", value: "xhigh" },
    ];
    if (isSolModel(model)) {
      choices.push({ label: "ultra (Sol 限定)", value: "ultra" });
    }
    suggestions.push({
      key: "model_reasoning_effort",
      label: "Reasoning effort",
      type: "select",
      description:
        "Codex/GPT only. codex は one-shot config override (`-c model_reasoning_effort=`)、" +
        "codex-sdk は Satelles の `--effort` として渡る。",
      choices,
    });
  }
  if (provider === "claude") {
    suggestions.push({
      key: "thinking",
      label: "Extended thinking",
      type: "boolean",
      description:
        "Opus は既定で OFF。true で有効化、false で明示的に無効化します。",
    });
    suggestions.push({
      key: "effort",
      label: "Effort",
      type: "select",
      description: "Claude Code effort. Opus は既定 high、auto は過去の delegation 結果から学習します。",
      choices: [
        { label: "auto (learned)", value: "auto" },
        { label: "low", value: "low" },
        { label: "medium", value: "medium" },
        { label: "high", value: "high" },
        { label: "xhigh", value: "xhigh" },
        { label: "max", value: "max" },
      ],
    });
    suggestions.push({
      key: "fast_mode",
      label: "Fast mode",
      type: "boolean",
      description: "Claude Code の /fast 相当を起動セッションに引き継ぐ (CONCORDIA_DELEGATION_FAST_MODE env)。",
    });
  }
  suggestions.push({
    key: "goal_and_go",
    label: "ゴールアンドゴー (自走継続)",
    type: "boolean",
    description: "最終回答後に人間入力がなければ、上限付きで同じセッションの残作業を自走継続します。",
  });
  return suggestions;
}

export function goalAndGoEnabled(options: DelegationRuntimeOptions | null | undefined): boolean {
  return !isPlainRecord(options) || options.goal_and_go !== false;
}

/** Build the Claude/Concordia runtime environment for a spawned delegation. */
export function resolveDelegationRuntimeEnv(
  provider: string,
  options: DelegationRuntimeOptions | null | undefined,
  effectiveModel?: string | null,
): Record<string, string> {
  const o = isPlainRecord(options) ? options : {};
  const env: Record<string, string> = {};
  if (provider === "claude") {
    const thinkingEnabled = resolveClaudeThinkingEnabled(o.thinking, effectiveModel);
    // `1` disables thinking regardless of ~/.claude settings. Set `0` for an
    // explicit opt-in so a parent environment cannot keep it disabled.
    if (thinkingEnabled === false) env.CLAUDE_CODE_DISABLE_THINKING = "1";
    if (thinkingEnabled === true && o.thinking === true) {
      env.CLAUDE_CODE_DISABLE_THINKING = "0";
    }
  }
  if (provider === "claude" && o.fast_mode === true) {
    env.CONCORDIA_DELEGATION_FAST_MODE = "1";
  }
  // Always override the inherited value. In particular, an explicit opt-out
  // must not be turned back on by Concordia's own ambient default.
  env.CONCORDIA_DELEGATION_GOAL_AND_GO = goalAndGoEnabled(options) ? "1" : "0";
  return env;
}

/** codex ファミリ (CLI wrap の `codex` と Satelles headless の `codex-sdk`)。 */
export function isCodexFamilyProvider(provider: string): boolean {
  return provider === "codex" || provider === "codex-sdk";
}

/** Whether the resolved Claude model is an Opus family model. */
export function isClaudeOpusModel(provider: string, model: string | null | undefined): boolean {
  return provider === "claude" && (model ?? "").trim().toLowerCase().includes("opus");
}

function supportsCodexReasoningEffort(model: string | null | undefined): boolean {
  const normalized = (model ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.includes("codex")
  );
}

/** GPT-5.6 Sol (model_id 末尾 `-sol`) かどうか。ultra effort は Sol 限定。 */
function isSolModel(model: string | null | undefined): boolean {
  const normalized = (model ?? "").trim().toLowerCase();
  return normalized === "sol" || normalized.endsWith("-sol");
}

/** Opus delegations default to no extended thinking; an explicit boolean wins. */
function resolveClaudeThinkingEnabled(value: unknown, model: string | null | undefined): boolean | null {
  if (typeof value === "boolean") return value;
  const normalized = (model ?? "").trim().toLowerCase();
  return normalized.includes("opus") ? false : null;
}

/** @implements spec/feature/delegation.md — 13.2 codex-sdk (`SPEC-DELEGATION-CODEX-SDK`) */
export function resolveDelegationRuntimeArgs(
  provider: string,
  options: DelegationRuntimeOptions | null | undefined,
  warningLog: ProviderPresetLog = log,
): string[] {
  if (provider === "claude") {
    const o = isPlainRecord(options) ? options : {};
    const effort = normalizeProviderEffort(provider, o.effort ?? o.reasoning_effort);
    return effort ? ["--effort", effort] : [];
  }
  if (provider === "codex-sdk") {
    // Satelles CLI は `--effort` を直接受ける (内部で -c model_reasoning_effort= に
    // 変換する)。 codex_config の素通しレーンは持たない (必要になったら Satelles 側に
    // 明示フラグを足してから配線する — 無言の互換レイヤは作らない)。
    const rawOptions = isPlainRecord(options) ? options : {};
    const effectiveOptions = resolveEffectiveDelegationRuntimeOptions(provider, options);
    // codex 経路が無視した override を 1 件ずつ warn するのと同じ扱いにする
    // (§6 無言のフォールバック禁止)。 ここで黙って捨てると、 codex 用テンプレを
    // codex-sdk に付け替えた利用者は sandbox_mode 等が効いていると誤認する。
    const droppedConfig = isPlainRecord(rawOptions.codex_config)
      ? Object.keys(rawOptions.codex_config).filter((k) => k !== "model_reasoning_effort")
      : [];
    if (droppedConfig.length > 0) {
      warningLog.warn(
        { provider, ignored_keys: droppedConfig },
        "codex_config is ignored for codex-sdk: Satelles has no raw `-c` passthrough lane; " +
        "model_reasoning_effort is the only key honored (as --effort)",
      );
    }
    const effort = normalizeProviderEffort(
      provider,
      effectiveOptions.model_reasoning_effort ?? effectiveOptions.reasoning_effort,
    );
    // 委託ライフサイクルは network 前提 (git push / PR 作成 / Cc への
    // run-status コールバック)。codex 側の network_access=false 拒否と同じ理由で、
    // codex-sdk 委託は常に --network を付ける。
    return [...(effort ? ["--effort", effort] : []), "--network"];
  }
  if (provider !== "codex") return [];
  const args: string[] = [];
  const effectiveOptions = resolveEffectiveDelegationRuntimeOptions(provider, options);
  const effort = normalizeProviderEffort(
    provider,
    effectiveOptions.model_reasoning_effort ?? effectiveOptions.reasoning_effort,
  );
  if (effort) {
    args.push("-c", `model_reasoning_effort=${tomlScalar(effort)}`);
  }
  const config = isPlainRecord(effectiveOptions.codex_config) ? effectiveOptions.codex_config : {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "model_reasoning_effort") continue;
    if (!CODEX_CONFIG_KEY_RE.test(key)) continue;
    if (value === undefined || value === null) continue;
    // `model` は resolveDelegationSpawn (modelInput → `--model` フラグ) が唯一の
    // 情報源。 codex_config 経由でも `-c model=...` を素通しすると、 Concordia が
    // 記録・通知する「要求 model」(spawn.effectiveModel) と実際に codex へ渡る
    // model の 2 経路が並立し、 値が食い違うケースで「要求と実行が不一致」に
    // なる (継続レビュー指摘)。 model は常にこの専用経路のみを単一情報源とし、
    // codex_config 側の重複指定は黙って壊さず転送せず理由をログに残す。
    if (key === "model") {
      warningLog.warn(
        { provider, requested_value: value },
        "codex_config.model is ignored: model must be set via the dedicated " +
        "modelInput/--model resolution path, not a duplicate config override",
      );
      continue;
    }
    // codex サンドボックスの `network_access=false` は全通信を遮断するため、
    // git push / `gh pr create` / Concordia 自身への run-status コールバック
    // (POST /v1/delegation/runs/:id/status) まで一律に不可能にしてしまう。
    // これらは delegation ライフサイクルの前提 (完了報告) であり、 ローカルの
    // git 操作 (commit/branch/diff) だけを許可する細かい制御は codex 側に無い
    // (all-or-nothing のサンドボックス設定) ため、 この上書きは黙って壊さず
    // 転送せず理由をログに残す (fail-fast; §6 無言のフォールバック禁止)。
    if (key === "network_access" && isNetworkAccessDisabled(value)) {
      warningLog.warn(
        { provider, requested_value: value },
        "codex_config.network_access=false is ignored: it would block " +
        "git push / PR creation / Concordia's own run-status callback",
      );
      continue;
    }
    args.push("-c", `${key}=${tomlScalar(value)}`);
  }
  return args;
}

/** `network_access` 値が「無効化」の意図かどうか (boolean / 文字列表現の両対応)。 */
function isNetworkAccessDisabled(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "false";
  return false;
}

export function resolveEffectiveDelegationRuntimeOptions(
  provider: string,
  options: DelegationRuntimeOptions | null | undefined,
  effectiveModel?: string | null,
): DelegationRuntimeOptions {
  const effectiveOptions = isPlainRecord(options) ? { ...options } : {};
  if (!isCodexFamilyProvider(provider)) {
    if (
      isClaudeOpusModel(provider, effectiveModel) &&
      effectiveOptions.effort === undefined &&
      effectiveOptions.reasoning_effort === undefined
    ) {
      effectiveOptions.effort = CLAUDE_OPUS_DEFAULT_EFFORT;
    }
    return effectiveOptions;
  }

  const config = isPlainRecord(effectiveOptions.codex_config) ? effectiveOptions.codex_config : {};
  const effort = normalizeReasoningEffort(
    effectiveOptions.model_reasoning_effort ??
    effectiveOptions.reasoning_effort ??
    config.model_reasoning_effort,
  );
  effectiveOptions.model_reasoning_effort = effort ?? CODEX_DEFAULT_REASONING_EFFORT;
  return effectiveOptions;
}

function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

export function normalizeProviderEffort(provider: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return null;
  if (isCodexFamilyProvider(provider)) return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
  if (provider === "claude") return CLAUDE_REASONING_EFFORTS.has(normalized) ? normalized : null;
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return JSON.stringify(String(value));
}

/**
 * 論理 delegation provider を実 spawn (CLI + args) に解決する。
 *
 *  - gemma4-12 (旧名 gamma) : Lictor のネイティブ local-agent (`lictor gemma4-12`) を起動。
 *            codex CLI は経由しない。 モデルは `LICTOR_LOCAL_MODEL` env で渡す
 *            (CLI フラグではないので args は空)。 推論は Ollama 上のローカルモデル。
 *  - codex-sdk : Satelles ヘッドレスランナー (`satelles run|serve`)。 wt.exe /
 *            Lictor を使わない (spawner.ts の HEADLESS_SPAWN_PROVIDERS)。 model は
 *            `--model` (Satelles が `-c model=` に変換)、 effort は
 *            resolveDelegationRuntimeArgs の `--effort`。
 *  - それ以外 (claude/codex/gemini) : 同名 CLI をそのまま起動。 model 指定時のみ `--model`。
 */
export function resolveDelegationSpawn(
  target: string,
  model: string | null | undefined,
): ResolvedSpawn {
  // "gamma" は旧名 (DB に永続化済みの target_provider が残っているため受理する)。
  if (target === LOCAL_LLM_PROVIDER || target === "gamma") {
    const effectiveModel = (model ?? "").trim() || GEMMA4_12_DEFAULT_MODEL;
    return {
      provider: GEMMA4_12_SPAWN_PROVIDER,
      args: [],
      effectiveModel,
      env: { LICTOR_LOCAL_MODEL: effectiveModel },
    };
  }
  const m = (model ?? "").trim();
  return {
    provider: target as SpawnProvider,
    args: m ? ["--model", m] : [],
    effectiveModel: m || null,
  };
}
