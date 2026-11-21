// 設定の下書き 1 件を、保存前に画面で確かめる (サーバの検証 apply.ts と同じ stringPattern を使う)。
//
// サーバは条件に合わない値を 400 で拒否するだけなので、入力欄のそばで「このままでは保存できない」と
// 分からないと、一覧の上に出る拒否文を見落として「保存されない」になる。判定の正本はサーバで、
// ここは入力中の案内だけを返す (値そのものは返さない)。
// @implements spec/feature/playtest-review-notify.md — 認証

import type { SettingItem } from "../../../api.js";

/** 下書きが入力条件に合わないときの案内。合う・条件が無い・下書きが無いときは null。 */
export function draftProblem(setting: Pick<SettingItem, "stringPattern" | "stringPatternDescription">, draft: unknown): string | null {
  if (typeof draft !== "string" || !setting.stringPattern) return null;
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  let pattern: RegExp;
  try {
    pattern = new RegExp(setting.stringPattern, "u");
  } catch {
    return null;
  }
  if (pattern.test(trimmed)) return null;
  return `入力条件に合わないため保存できません: ${setting.stringPatternDescription ?? "形式が違います"} (今 ${[...trimmed].length} 文字)`;
}
