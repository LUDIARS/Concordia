/**
 * 質問カードの選択肢コード (`[A]`, `[B]`, …) — WebUI 表示用。
 *
 * サーバ側 `src/shared/option-code.ts`、Lictor `src/answer-code.ts` と同じ規則。
 * WebUI は API バンドルを共有しないため、表示用の最小実装だけをここに持つ。
 */

const CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** `0 → "A"`, `25 → "Z"`。Z を超えたら 1 始まりの番号にフォールバックする。 */
export function formatOptionCode(index: number): string {
  if (!Number.isInteger(index) || index < 0) return '?';
  return index < CODE_LETTERS.length ? CODE_LETTERS[index]! : String(index + 1);
}

/** `"first" → "[A] first"`。 */
export function labelWithOptionCode(index: number, label: string): string {
  return `[${formatOptionCode(index)}] ${label}`;
}
