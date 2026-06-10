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
  { provider: "claude", model_id: "claude-opus-4-8", label: "Opus 4.8", sort_order: 10 },
  { provider: "claude", model_id: "claude-sonnet-4-6", label: "Sonnet 4.6", sort_order: 20 },
  { provider: "claude", model_id: "claude-fable-5", label: "Fable 5", sort_order: 25 },
  { provider: "claude", model_id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", sort_order: 30 },
  // ── Codex ────────────────────────────────────────────────
  { provider: "codex", model_id: "gpt-5.3-codex", label: "GPT-5.3 Codex", sort_order: 10 },
  { provider: "codex", model_id: "gpt-5.5", label: "GPT-5.5", sort_order: 20 },
  // ── Gemini ───────────────────────────────────────────────
  { provider: "gemini", model_id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", sort_order: 10 },
  { provider: "gemini", model_id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", sort_order: 20 },
  // ── gemma4-12 (ローカル LLM / Ollama 経由、 codex CLI を OSS で起動。 旧名 gamma) ──
  // 既存 DB には seed が走らない (table 非空なら skip) ので、 運用側は Settings→Models で追加。
  { provider: "gemma4-12", model_id: "gemma4:12b", label: "Gemma 4 12B (Ollama)", sort_order: 10 },
];

export function seedModelCatalog(repo: ModelCatalogRepo): void {
  // 既に 1 件でもあれば seed しない (ユーザが消したモデルを毎 boot で復活させない)。
  if (repo.list({ includeInactive: true }).length > 0) return;
  for (const m of SEED_MODELS) {
    repo.upsert(m);
  }
}
