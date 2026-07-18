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

const CODEX_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "ultra"]);
const CLAUDE_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CODEX_CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function delegationOptionSuggestions(provider: string, model?: string | null): DelegationOptionSuggestion[] {
  const suggestions: DelegationOptionSuggestion[] = [];
  if (provider === "codex" && supportsCodexReasoningEffort(model)) {
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
      description: "Codex/GPT only. Passed as a one-shot Codex config override.",
      choices,
    });
  }
  if (provider === "claude") {
    suggestions.push({
      key: "effort",
      label: "Effort",
      type: "select",
      description: "Claude Code effort. Auto learns from prior delegation outcomes.",
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

export function goalAndGoRequested(options: DelegationRuntimeOptions | null | undefined): boolean {
  return isPlainRecord(options) && options.goal_and_go === true;
}

/** Spawned Lictor can also preserve the opt-in when it builds registration metadata. */
export function resolveDelegationRuntimeEnv(
  provider: string,
  options: DelegationRuntimeOptions | null | undefined,
): Record<string, string> {
  const o = isPlainRecord(options) ? options : {};
  const env: Record<string, string> = {};
  if (provider === "claude" && o.fast_mode === true) {
    env.CONCORDIA_DELEGATION_FAST_MODE = "1";
  }
  if (goalAndGoRequested(options)) {
    env.CONCORDIA_DELEGATION_GOAL_AND_GO = "1";
  }
  return env;
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

export function resolveDelegationRuntimeArgs(
  provider: string,
  options: DelegationRuntimeOptions | null | undefined,
): string[] {
  if (provider === "claude") {
    const o = isPlainRecord(options) ? options : {};
    const effort = normalizeProviderEffort(provider, o.effort ?? o.reasoning_effort);
    return effort ? ["--effort", effort] : [];
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
      log.warn(
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
      log.warn(
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
): DelegationRuntimeOptions {
  const effectiveOptions = isPlainRecord(options) ? { ...options } : {};
  if (provider !== "codex") return effectiveOptions;

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
  if (provider === "codex") return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
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
