/**
 * 投稿者 (セッション) の活動シグナルから人格 (PersonaDraft) を合成する.
 *
 * - 主経路: claude CLI に signals を渡して name/description/traits/speech_style を 1 体生成
 * - fallback: CONCORDIA_DISABLE_CLAUDE=1 or claude 失敗時は signals だけから heuristic 生成
 *
 * ここでは「人格の中身」を決めるだけ. DB への upsert / assign は personas-repo の
 * createGenerated が、 シグナル収集は signals.ts が担う (SRP).
 */

import type { PersonaSignals } from "./signals.js";
import { buildSkillTemplate } from "./skill-template.js";
import { runClaude, extractJson } from "../rules/claude-runner.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("persona-generate");

export interface PersonaDraft {
  name: string;
  display_name: string;
  description: string;
  traits: string[];
  speech_style: string;
  skill_template: string;
}

/** file_focus ラベルを日本語の説明語に. */
const FOCUS_WORDS: Record<string, string> = {
  test: "テスト",
  infra: "インフラ・運用",
  spec: "仕様・ドキュメント",
  src: "実装コード",
};

function focusText(focus: string[]): string {
  const words = focus.map((f) => FOCUS_WORDS[f] ?? f);
  return words.length > 0 ? words.join("・") : "雑多な作業";
}

/**
 * シグナルから人格を 1 体合成する. 常に有効な PersonaDraft を返す
 * (LLM が使えない / 失敗しても heuristic で必ず埋める).
 */
export async function generatePersonaDraft(signals: PersonaSignals): Promise<PersonaDraft> {
  if (process.env.CONCORDIA_DISABLE_CLAUDE === "1") {
    return heuristicDraft(signals);
  }
  const r = await runClaude(buildPrompt(signals));
  if (!r.ok) {
    log.warn({ session_id: signals.session_id }, "claude failed; using heuristic persona draft");
    return heuristicDraft(signals);
  }
  const parsed = extractJson(r.stdout);
  const draft = coerceDraft(parsed);
  if (!draft) {
    log.warn({ session_id: signals.session_id }, "claude output unparseable; using heuristic persona draft");
    return heuristicDraft(signals);
  }
  return draft;
}

function buildPrompt(s: PersonaSignals): string {
  return [
    "あなたは Concordia の \"人格デザイナー\" です. 1 つの AI 作業セッション (= それを操作する人間) の",
    "活動シグナルを渡すので、 その働き方の個性を反映した架空の人格を **1 体だけ** 設計してください.",
    "",
    "## 制約",
    "- 出力は JSON 1 つだけ. 余計な前置き・コードフェンスなし.",
    "- name: ロール名 (日本語, 12 文字以内, 例 \"テスト魂\")",
    "- display_name: 人物名 (日本語の姓名っぽい 2〜5 文字, 例 \"境野 詰\")",
    "- description: 1 文 (80 文字以内). この人格の核.",
    "- traits: 3〜6 個の短い特性語 (各 12 文字以内) の配列.",
    "- speech_style: 喋り方の癖を 1〜2 文 (120 文字以内).",
    "- 中立的・前向きに. 個人を特定する固有名詞や PII は入れない.",
    "",
    "## セッションの活動シグナル",
    `repo: ${s.repo_base}`,
    `branch: ${s.branch ?? "(なし)"}`,
    `provider: ${s.provider}`,
    `推定ロール (たたき台): ${s.role_label}`,
    `現在のタスク: ${s.current_task ?? "(不明)"}`,
    `prompt 回数: ${s.prompt_count} / edit 回数: ${s.edit_count}`,
    `よく使う tool: ${s.dominant_tools.join(", ") || "(データなし)"}`,
    `編集対象の傾向: ${focusText(s.file_focus)}`,
    `chat に出た発言者: ${s.voices.join(", ") || "(なし)"}`,
    "",
    "## chat 抜粋 (最大 20 行)",
    s.chat_samples.join("\n") || "(発言なし)",
    "",
    "## 出力 (この形の JSON 1 つだけ)",
    `{"name":"","display_name":"","description":"","traits":["",""],"speech_style":""}`,
  ].join("\n");
}

/** LLM 出力 (unknown) を PersonaDraft に矯正. 必須フィールドが揃わなければ null. */
function coerceDraft(parsed: unknown): PersonaDraft | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 24) : "";
  const description = typeof o.description === "string" ? o.description.trim().slice(0, 200) : "";
  const speech = typeof o.speech_style === "string" ? o.speech_style.trim().slice(0, 400) : "";
  if (!name || !description || !speech) return null;
  const display = typeof o.display_name === "string" && o.display_name.trim()
    ? o.display_name.trim().slice(0, 24)
    : name;
  const traits = Array.isArray(o.traits)
    ? o.traits.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, 24)).filter(Boolean).slice(0, 8)
    : [];
  if (traits.length === 0) traits.push(name);
  return {
    name,
    display_name: display,
    description,
    traits,
    speech_style: speech,
    skill_template: buildSkillTemplate({ name, description, traits, speech_style: speech }),
  };
}

/**
 * LLM 無効 / 失敗時の決定論的 fallback. シグナルだけから素朴な人格を組む.
 * 「最低限それらしい」 ことを優先し、 LLM 経路の品質は求めない.
 */
function heuristicDraft(s: PersonaSignals): PersonaDraft {
  const name = s.role_label;
  const display_name = `${s.repo_base}番`;
  const focus = focusText(s.file_focus);
  const tempo = s.edit_count > s.prompt_count * 3 ? "手数で押す" : "考えてから動く";
  const description =
    `${s.repo_base} を主戦場に ${focus} を中心へ ${tempo} ${s.role_label} 気質 (活動シグナルから生成).`.slice(0, 200);
  const traits = [
    `${s.repo_base} 中心`,
    focus,
    tempo,
    ...(s.dominant_tools[0] ? [`${s.dominant_tools[0]} 多用`] : []),
  ].slice(0, 6);
  const speech_style =
    `${s.role_label} らしく ${focus} の話題に強い. 事実ベースで簡潔に話す (heuristic 生成).`;
  return {
    name,
    display_name,
    description,
    traits,
    speech_style,
    skill_template: buildSkillTemplate({ name, description, traits, speech_style }),
  };
}
