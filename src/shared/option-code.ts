/**
 * 質問カードの選択肢コード (`[A]`, `[B]`, …)。
 *
 * カードはボタン / WebUI / テキスト返信の 3 経路から答えられる。 前 2 者は選択肢の
 * index を持つが、 テキスト返信は本文しか持たないため、 どの選択肢かを一意に指す
 * 手がかりとしてコードを表示する (Lictor 側 `src/answer-code.ts` が同じ規則で解釈する)。
 *
 * コードは**手がかりであって書式の強制ではない**。 選択肢の外を答える返信も正当な回答として
 * 自由文で記録される。
 */

const CODE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** `0 → "A"`, `25 → "Z"`。 Z を超えたら 1 始まりの番号にフォールバックする。 */
export function formatOptionCode(index: number): string {
  if (!Number.isInteger(index) || index < 0) return "?";
  return index < CODE_LETTERS.length ? CODE_LETTERS[index]! : String(index + 1);
}

/** `"first" → "[A] first"`。 表示用のラベル整形。 */
export function labelWithOptionCode(index: number, label: string): string {
  return `[${formatOptionCode(index)}] ${label}`;
}
