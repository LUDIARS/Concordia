/**
 * 部署のセッションの初回指示に並べる「対話の前提データ」ブロックを組み立てる純関数。
 *
 * 訂正は新しい順に件数と合計文字数で切る (CC-DLG-INV-02)。 上限を超えた古い訂正は
 * 捨てるのではなく「渡さない」だけで、 保存はそのまま残る。
 *
 * @implements spec/feature/dialogue-context.md §5
 * @implements SPEC-DLG-STARTUP
 * @implements SPEC-CONSULT-INTAKE
 */

import { CONSULT_INTAKE_FIELDS, CONSULT_INTAKE_LABELS, type ConsultIntake } from "./intake.js";
import { skillLevelGuidance } from "./skill-level.js";

export const MAX_LAUNCH_CORRECTIONS = 30;
export const MAX_LAUNCH_CORRECTION_CHARS = 6_000;

export interface StartupBlockInput {
  departmentName: string;
  useCase: {
    name: string;
    formatName: string;
    summary: string;
    preData: string;
  };
  /** 新しい順。 呼び出し側は会社で絞った有効な訂正だけを渡す。 */
  corrections: ReadonlyArray<{ question: string; correction: string }>;
  /** 依頼者メモを使う設定で、 依頼者が分かるときだけ渡す。 */
  requester?: {
    displayName: string;
    skillLevel: string;
    activities: string;
    notes: string;
  } | null;
  /** 事前ヒアリング (tech-consultation.md §3)。 ユースケースが使う設定で、 揃ったときだけ渡す。 */
  intake?: ConsultIntake | null;
}

export function buildDialogueStartupBlock(input: StartupBlockInput): string {
  const lines: string[] = [
    `## 部署: ${input.departmentName} / ユースケース: ${input.useCase.name} (${input.useCase.formatName})`,
  ];
  const summary = input.useCase.summary.trim();
  if (summary) lines.push(summary);
  const preData = input.useCase.preData.trim();
  if (preData) lines.push("", "### 事前データ", preData);
  const corrections = selectCorrections(input.corrections);
  if (corrections.length > 0) {
    lines.push("", "### これまでの訂正 (人が直した内容。事前データと矛盾したらこちらに従う)");
    lines.push(...corrections);
  }
  const requester = renderRequester(input.requester ?? null);
  if (requester.length > 0) lines.push("", "### 依頼者について", ...requester);
  const intake = renderIntake(input.intake ?? null);
  if (intake.length > 0) {
    lines.push("", "### 今回の相談 (この技術レベル・役職・目的に合わせた粒度で答える)", ...intake);
  }
  return lines.join("\n");
}

function selectCorrections(corrections: StartupBlockInput["corrections"]): string[] {
  const selected: string[] = [];
  let total = 0;
  for (const correction of corrections.slice(0, MAX_LAUNCH_CORRECTIONS)) {
    const text = correction.correction.trim();
    if (!text) continue;
    const question = correction.question.trim();
    const line = question ? `- 問: ${oneLine(question)} / 訂正: ${oneLine(text)}` : `- 訂正: ${oneLine(text)}`;
    if (total + line.length > MAX_LAUNCH_CORRECTION_CHARS) break;
    selected.push(line);
    total += line.length;
  }
  return selected;
}

function renderRequester(requester: StartupBlockInput["requester"]): string[] {
  if (!requester) return [];
  const items: Array<[string, string]> = [
    ["技術者レベル", requester.skillLevel],
    ["やっていること", requester.activities],
    ["メモ", requester.notes],
  ];
  const filled = items.filter(([, value]) => value.trim());
  // 表示名だけのメモは前提として役に立たないので節ごと省く。
  if (filled.length === 0) return [];
  const name = requester.displayName.trim();
  return [
    ...(name ? [`- 名前: ${oneLine(name)}`] : []),
    ...filled.map(([label, value]) => `- ${label}: ${oneLine(value)}`),
  ];
}

function renderIntake(intake: ConsultIntake | null): string[] {
  if (!intake) return [];
  const lines = CONSULT_INTAKE_FIELDS.map((field) => {
    const value = intake[field].trim();
    // 目的は任意。 空でも「知ること自体が目的」として扱えるよう明示する。
    if (!value) return field === "purpose" ? `- ${CONSULT_INTAKE_LABELS[field]}: (回答なし。知ること自体が目的として扱う)` : null;
    return `- ${CONSULT_INTAKE_LABELS[field]}: ${oneLine(value)}`;
  }).filter((line): line is string => line !== null);
  // 技術レベルに合わせた説明の仕方 (初級 / 中級 / 上級、 tech-consultation.md §3)。
  return intake.skill_level.trim() ? [...lines, ...skillLevelGuidance(intake.skill_level)] : lines;
}

/** 改行を詰めて 1 行にする (Markdown の箇条書きを崩さない)。 */
function oneLine(text: string): string {
  return text.trim().replace(/\s*\r?\n\s*/g, " / ");
}
