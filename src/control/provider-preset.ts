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

const CODEX_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
const CODEX_CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function delegationOptionSuggestions(provider: string, model?: string | null): DelegationOptionSuggestion[] {
  if (provider !== "codex") return [];
  if (!supportsCodexReasoningEffort(model)) return [];
  return [
    {
      key: "model_reasoning_effort",
      label: "Reasoning effort",
      type: "select",
      description: "Codex/GPT only. Passed as a one-shot Codex config override.",
      choices: [
        { label: "minimal", value: "minimal" },
        { label: "low", value: "low" },
        { label: "medium", value: "medium" },
        { label: "high", value: "high" },
      ],
    },
  ];
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

export function resolveDelegationRuntimeArgs(
  provider: string,
  options: DelegationRuntimeOptions | null | undefined,
): string[] {
  if (!options || provider !== "codex") return [];
  const args: string[] = [];
  const effort = normalizeReasoningEffort(options.model_reasoning_effort ?? options.reasoning_effort);
  if (effort) {
    args.push("-c", `model_reasoning_effort=${tomlScalar(effort)}`);
  }
  const config = isPlainRecord(options.codex_config) ? options.codex_config : {};
  for (const [key, value] of Object.entries(config)) {
    if (!CODEX_CONFIG_KEY_RE.test(key)) continue;
    if (value === undefined || value === null) continue;
    args.push("-c", `${key}=${tomlScalar(value)}`);
  }
  return args;
}

function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
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
