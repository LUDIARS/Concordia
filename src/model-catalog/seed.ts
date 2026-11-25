/**
 * 初期モデルカタログ。 boot 時に upsert される (provider+model_id が無ければ作成)。
 *
 * これらは「手動更新できる選択肢」の初期値にすぎない。 新モデル登場 / 旧モデル廃止は
 * Web UI (Settings → Models) から CRUD する想定で、 seed はあくまで空表を避けるため。
 *
 * Claude / Codex の有効行は role-policy (INITIAL_CLAUDE_ROLE_MODELS / INITIAL_ROLE_MODELS) の
 * 現行値と一致させる (seed.test.ts が突き合わせる)。 旧世代の行は既存 DB にあれば無効化だけして残す
 * (料金・過去 run の表示に使うため消さない)。 spec/feature/model-role-map.md
 */

import type { CreateModelInput, ModelCatalogRepo } from "../db/model-catalog-repo.js";
import { initialRoleModel } from "./role-policy.js";

/** role-policy と揃えた現行の有効行。 */
const CURRENT_ROLE_MODELS: CreateModelInput[] = [
  { provider: "claude", model_id: "claude-opus-5-5", label: "Opus 5.5", sort_order: 10 },
  { provider: "claude", model_id: "claude-sonnet-5-5", label: "Sonnet 5.5", sort_order: 20 },
  { provider: "claude", model_id: "claude-fable-5-2", label: "Fable 5.2", sort_order: 23 },
  { provider: "claude", model_id: "claude-haiku-5-5", label: "Haiku 5.5", sort_order: 29 },
  { provider: "codex", model_id: "gpt-6.2-astra", label: "GPT-6.2 Astra", sort_order: 4 },
  { provider: "codex", model_id: "gpt-6.2-sol", label: "GPT-6.2 Sol", sort_order: 9 },
  { provider: "codex", model_id: "gpt-6-luna", label: "GPT-6 Luna", sort_order: 30 },
  // 2026-11-20 neco 指示「Gemini Neon を組み込みたい」「Argon と Neon を指定できるように」。 役割 neon / argon (MRM-GEM-01)。
  // Gemini 系の既定は Neon なので sort_order は neon < argon (MRM-GEM-05)。
  { provider: "gemini", model_id: "gemini-4-neon", label: "Gemini 4 Neon", sort_order: 5 },
  { provider: "gemini", model_id: "gemini-4-argon", label: "Gemini 4 Argon", sort_order: 6 },
  { provider: "grok", model_id: initialRoleModel("grok"), label: "Grok 4.7", sort_order: 7 },
];

const SEED_MODELS: CreateModelInput[] = [
  ...CURRENT_ROLE_MODELS,
  // ── Gemini ───────────────────────────────────────────────
  { provider: "gemini", model_id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", sort_order: 10 },
  { provider: "gemini", model_id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", sort_order: 20 },
  // ── gemma4-12 (ローカル LLM / Ollama 経由、 codex CLI を OSS で起動。 旧名 gamma) ──
  { provider: "gemma4-12", model_id: "gemma4:12b", label: "Gemma 4 12B (Ollama)", sort_order: 10 },
];

/** 既存 DB にある場合だけ無効化する旧世代の行。 */
const RETIRED_MODEL_PATCHES: CreateModelInput[] = [
  { provider: "claude", model_id: "claude-sonnet-4-6", label: "Sonnet 4.6", sort_order: 92, is_active: false },
  { provider: "claude", model_id: "claude-fable-5-1", label: "Fable 5.1", sort_order: 93, is_active: false },
  { provider: "claude", model_id: "claude-fable-5", label: "Fable 5", sort_order: 94, is_active: false },
  { provider: "claude", model_id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", sort_order: 95, is_active: false },
  { provider: "claude", model_id: "claude-opus-5", label: "Opus 5", sort_order: 90, is_active: false },
  { provider: "claude", model_id: "claude-opus-4-8", label: "Opus 4.8", sort_order: 91, is_active: false },
  { provider: "codex", model_id: "gpt-6-astra", label: "GPT-6 Astra", sort_order: 95, is_active: false },
  { provider: "codex", model_id: "gpt-6.1-sol", label: "GPT-6.1 Sol", sort_order: 96, is_active: false },
  { provider: "codex", model_id: "gpt-5.6-terra", label: "GPT-5.6 Terra", sort_order: 93, is_active: false },
  { provider: "codex", model_id: "gpt-5.6-sol", label: "GPT-5.6 Sol", sort_order: 92, is_active: false },
  { provider: "codex", model_id: "gpt-5.6-luna", label: "GPT-5.6 Luna", sort_order: 94, is_active: false },
  { provider: "codex", model_id: "gpt-5.3-codex", label: "GPT-5.3 Codex", sort_order: 90, is_active: false },
  { provider: "codex", model_id: "gpt-5.5", label: "GPT-5.5", sort_order: 91, is_active: false },
];

/** テスト用: role-policy と突き合わせる現行の有効行。 */
export function currentRoleSeedModels(): readonly CreateModelInput[] {
  return CURRENT_ROLE_MODELS;
}

export function seedModelCatalog(repo: ModelCatalogRepo): void {
  // 既存 catalog には現行の行だけを追加する (ユーザが消した通常 seed を毎 boot で復活させない)。
  const rows = repo.list({ includeInactive: true });
  const models = rows.length > 0 ? CURRENT_ROLE_MODELS : SEED_MODELS;
  for (const m of models) {
    repo.upsert(m);
  }
  if (rows.length > 0) {
    for (const patch of RETIRED_MODEL_PATCHES) {
      if (rows.some((row) => row.provider === patch.provider && row.model_id === patch.model_id)) {
        repo.upsert(patch);
      }
    }
  }
}
