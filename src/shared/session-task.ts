/**
 * セッションのタスク本文に関する語彙。 API 層 (session 登録) と Discord 層 (投稿・pin)
 * の両方が参照するため shared に置く。
 */

/**
 * タスク未指定で spawn した素のセッションに与えるタスク本文。
 *
 * 空のまま登録すると Discord 側に何も写らず「何を頼まれたセッションなのか」が
 * 追えなくなる。 「タスクが無い」ことを明示のタスクとして渡す。
 */
export const BLANK_SESSION_TASK = "何もするな";

export function isBlankSessionTask(text: string | null | undefined): boolean {
  return (text ?? "").trim() === BLANK_SESSION_TASK;
}
