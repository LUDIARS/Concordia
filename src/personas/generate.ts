/**
 * 投稿者 (セッション) の活動シグナルから人格 (PersonaDraft) を合成する.
 *
 * **ペルソナエンジンは LLM を使わない** (方針転換 2026-06). signals だけから
 * 決定的に heuristic 生成する. 以前の claude CLI 生成経路は撤去した
 * (チャット発話のみ Haiku、 人格定義は静的データ).
 *
 * ここでは「人格の中身」を決めるだけ. DB への upsert / assign は personas-repo の
 * createGenerated が、 シグナル収集は signals.ts が担う (SRP).
 */

import type { PersonaSignals } from "./signals.js";
import { buildSkillTemplate } from "./skill-template.js";

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
  // 人格定義は静的データ. LLM を介さず signals から決定的に組む.
  return heuristicDraft(signals);
}

/**
 * シグナルだけから決定論的に人格を組む. 「最低限それらしい」 ことを優先する.
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
