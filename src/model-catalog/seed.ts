/**
 * 初期モデルカタログ。 boot 時に upsert される (provider+model_id が無ければ作成)。
 *
 * これらは「手動更新できる選択肢」の初期値にすぎない。 新モデル登場 / 旧モデル廃止は
 * Web UI (Settings → Models) から CRUD する想定で、 seed はあくまで空表を避けるため。
 * 値は変わりやすいので、 正確な最新表は運用側で更新する。
 */

import type { CreateModelInput, ModelCatalogRepo } from "../db/model-catalog-repo.js";

const SEED_MODELS: CreateModelInput[] = [
  // ── Claude (Claude Code) ─────────────────────────────────
  { provider: "claude", model_id: "claude-opus-5", label: "Opus 5", sort_order: 10 },
  { provider: "claude", model_id: "claude-sonnet-5", label: "Sonnet 5", sort_order: 20 },
  { provider: "claude", model_id: "claude-sonnet-4-6", label: "Sonnet 4.6", sort_order: 22 },
  { provider: "claude", model_id: "claude-fable-5-1", label: "Fable 5.1", sort_order: 24 },
  { provider: "claude", model_id: "claude-fable-5", label: "Fable 5", sort_order: 25 },
  { provider: "claude", model_id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", sort_order: 30 },
  // ── Codex ────────────────────────────────────────────────
  { provider: "codex", model_id: "gpt-6-astra", label: "GPT-6 Astra", sort_order: 5 },
  { provider: "codex", model_id: "gpt-5.6-sol", label: "GPT-5.6 Sol", sort_order: 10 },
  { provider: "codex", model_id: "gpt-5.6-terra", label: "GPT-5.6 Terra", sort_order: 20 },
  { provider: "codex", model_id: "gpt-5.6-luna", label: "GPT-5.6 Luna", sort_order: 30 },
  // ── Gemini ───────────────────────────────────────────────
  { provider: "gemini", model_id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", sort_order: 10 },
  { provider: "gemini", model_id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", sort_order: 20 },
  // ── gemma4-12 (ローカル LLM / Ollama 経由、 codex CLI を OSS で起動。 旧名 gamma) ──
  // 既存 DB には seed が走らない (table 非空なら skip) ので、 運用側は Settings→Models で追加。
  { provider: "gemma4-12", model_id: "gemma4:12b", label: "Gemma 4 12B (Ollama)", sort_order: 10 },
];

const ROLLING_SEED_MODELS: CreateModelInput[] = [
  { provider: "claude", model_id: "claude-opus-5", label: "Opus 5", sort_order: 10 },
  { provider: "claude", model_id: "claude-sonnet-5", label: "Sonnet 5", sort_order: 20 },
  { provider: "claude", model_id: "claude-fable-5-1", label: "Fable 5.1", sort_order: 24 },
  { provider: "codex", model_id: "gpt-6-astra", label: "GPT-6 Astra", sort_order: 5 },
  { provider: "codex", model_id: "gpt-5.6-sol", label: "GPT-5.6 Sol", sort_order: 10 },
  { provider: "codex", model_id: "gpt-5.6-terra", label: "GPT-5.6 Terra", sort_order: 20 },
  { provider: "codex", model_id: "gpt-5.6-luna", label: "GPT-5.6 Luna", sort_order: 30 },
];

const ROLLING_EXISTING_MODEL_PATCHES: CreateModelInput[] = [
  { provider: "claude", model_id: "claude-opus-4-8", label: "Opus 4.8", sort_order: 90, is_active: false },
  { provider: "claude", model_id: "claude-sonnet-4-6", label: "Sonnet 4.6", sort_order: 22 },
  { provider: "codex", model_id: "gpt-5.3-codex", label: "GPT-5.3 Codex", sort_order: 90, is_active: false },
  { provider: "codex", model_id: "gpt-5.5", label: "GPT-5.5", sort_order: 91, is_active: false },
];

export function seedModelCatalog(repo: ModelCatalogRepo): void {
  // 既存 catalog には新規公開モデルだけを追加する (ユーザが消した通常 seed を毎 boot で復活させない)。
  const rows = repo.list({ includeInactive: true });
  const models = rows.length > 0 ? ROLLING_SEED_MODELS : SEED_MODELS;
  for (const m of models) {
    repo.upsert(m);
  }
  if (rows.length > 0) {
    for (const patch of ROLLING_EXISTING_MODEL_PATCHES) {
      if (rows.some((row) => row.provider === patch.provider && row.model_id === patch.model_id)) {
        repo.upsert(patch);
      }
    }
  }
}
