/**
 * LLM パス: 矛盾検査 + 自動整理サジェスト (提案のみ、 自動適用しない = req 3/7)。
 *
 * - claude -p (haiku) を 1 メモリ home 単位で呼ぶ (プロンプト肥大回避)。
 * - LUDIARS は API 不使用・claude CLI のみ (memory 準拠)。 `runClaude` を流用。
 * - `CONCORDIA_DISABLE_CLAUDE=1` は明示 OFF (テスト/緊急停止) → disabled で返す
 *   (これは設定不備の silent fallback ではなく明示選択なので可)。
 */

import { runClaude, extractJson } from "../rules/claude-runner.js";
import type { LibrarySource, Suggestion } from "./types.js";

export interface AnalyzeResult {
  disabled: boolean;
  model: string;
  suggestions: Suggestion[];
  /** claude 失敗時の理由 (API は 502 にする)。 */
  error?: string;
}

const VALID_KINDS = new Set<Suggestion["kind"]>([
  "contradiction",
  "merge",
  "archive",
  "shorten",
  "split",
]);

export async function analyzeHome(source: LibrarySource): Promise<AnalyzeResult> {
  if (process.env.CONCORDIA_DISABLE_CLAUDE === "1") {
    return { disabled: true, model: "haiku", suggestions: [] };
  }

  const blocks = source.blocks.filter((b) => !b.flags.orphanIndex);
  if (blocks.length === 0) {
    return { disabled: false, model: "haiku", suggestions: [] };
  }

  // name → id の対応 (LLM には name で参照させ、 こちらで id に戻す)。
  const nameToId = new Map<string, string>();
  for (const b of blocks) nameToId.set(b.name, b.id);

  const listing = blocks
    .map((b) => `- ${b.name}: ${b.title}${b.description ? ` — ${b.description}` : ""}`)
    .join("\n");

  const prompt = [
    "あなたは Concordia の **メモリ/スキル整理アシスタント** です。",
    `下記は "${source.label}" に蓄積されたルール/メモリ一覧 (name: タイトル — 説明) です。`,
    "矛盾するもの、 重複/統合できるもの、 退避(アーカイブ)すべき陳腐化したもの、 短縮すべきものを指摘してください。",
    "",
    "## 一覧",
    listing,
    "",
    "## 出力 (JSON 1 オブジェクトのみ、 前置き/コードフェンスなし)",
    "{",
    '  "suggestions": [',
    '    {"kind": "contradiction|merge|archive|shorten|split", "names": ["<name>", ...], "message": "<日本語1-2文>", "rationale": "<根拠>"}',
    "  ]",
    "}",
    "",
    "- names は上記 name をそのまま使う (存在しない name は出さない)。",
    "- 確信が持てないものは出さない (誤検知より silence)。",
    "- 自動適用はされず、 人間が確認して退避するための提案である。",
  ].join("\n");

  const r = await runClaude(prompt, { model: "haiku" });
  if (!r.ok) {
    return { disabled: false, model: "haiku", suggestions: [], error: r.stderr.slice(0, 300) };
  }

  const json = extractJson(r.stdout);
  if (!json || typeof json !== "object") {
    return {
      disabled: false,
      model: "haiku",
      suggestions: [],
      error: `unparsable: ${r.stdout.slice(0, 200)}`,
    };
  }

  const rawSuggestions = (json as { suggestions?: unknown }).suggestions;
  const suggestions: Suggestion[] = [];
  if (Array.isArray(rawSuggestions)) {
    for (const s of rawSuggestions) {
      const parsed = normalizeSuggestion(s, nameToId);
      if (parsed) suggestions.push(parsed);
    }
  }

  return { disabled: false, model: "haiku", suggestions };
}

function normalizeSuggestion(s: unknown, nameToId: Map<string, string>): Suggestion | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  const kind = o.kind as Suggestion["kind"];
  if (!VALID_KINDS.has(kind)) return null;
  const message = typeof o.message === "string" ? o.message.trim() : "";
  if (!message) return null;
  // names は配列のはずだが、 単一文字列で返るケースに備えて正規化 (memory 準拠)。
  const namesRaw = o.names;
  const names = Array.isArray(namesRaw)
    ? namesRaw
    : typeof namesRaw === "string"
      ? [namesRaw]
      : [];
  const blockIds: string[] = [];
  for (const n of names) {
    if (typeof n !== "string") continue;
    const id = nameToId.get(n.trim());
    if (id) blockIds.push(id);
  }
  if (blockIds.length === 0) return null; // 参照不能な提案は捨てる。
  return {
    kind,
    message,
    blockIds,
    rationale: typeof o.rationale === "string" ? o.rationale.trim() : undefined,
  };
}
