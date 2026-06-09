/**
 * Delegation の論理 provider → 実 spawn (CLI + args) 解決。
 *
 * delegation_templates.target_provider は「論理プリセット」で、 Lictor が実際に
 * 包む CLI (= SpawnProvider: claude/codex/gemini) とは必ずしも 1:1 でない。
 *
 * 特に **gemma4-12** は「ローカル LLM 委託レーン」で、 中身は OpenAI 互換ハーネスとして
 * `codex` CLI を使い、 推論は Ollama 上のローカルモデル (既定 Gemma 4 12B) が担う。
 * = 「OpenAI の Codex モデルではない」 ので、 表示・記録上は codex を見せず gemma4-12 と
 * 呼ぶ (実体は codex CLI を OSS プロバイダ経由で起動するだけ)。
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

/** gemma4-12 の実 spawn 先 CLI。 OSS (OpenAI 互換) を喋れる唯一の wrap 対象。 */
const GEMMA4_12_SPAWN_PROVIDER: SpawnProvider = "codex";

/** UI / プロンプトヘッダ向けの表示ラベル。 */
export const DELEGATION_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude (Claude Code)",
  codex: "Codex (OpenAI)",
  gemini: "Gemini",
  "gemma4-12": "gemma4-12 (ローカル LLM / Ollama)",
};

export interface ResolvedSpawn {
  /** 実際に lictor が wrap する CLI。 */
  provider: SpawnProvider;
  /** CLI に渡す追加 args (`--model` / OSS フラグ等)。 空配列なら付けない。 */
  args: string[];
  /** プロンプトヘッダ等に出す「実効モデル」。 gemma4-12 は既定を解決した値。 */
  effectiveModel: string | null;
}

/**
 * 論理 delegation provider を実 spawn (CLI + args) に解決する。
 *
 *  - gemma4-12 (旧名 gamma) : codex CLI を `--oss --local-provider ollama --model <model|既定>`
 *            で起動。 OpenAI の Codex モデルではなく、 Ollama 上のローカルモデルが推論する。
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
      args: ["--oss", "--local-provider", "ollama", "--model", effectiveModel],
      effectiveModel,
    };
  }
  const m = (model ?? "").trim();
  return {
    provider: target as SpawnProvider,
    args: m ? ["--model", m] : [],
    effectiveModel: m || null,
  };
}
