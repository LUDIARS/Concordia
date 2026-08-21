/**
 * セッションのタスク本文に関する語彙。 API 層 (session 登録) と Discord 層 (投稿・pin)
 * の両方が参照するため shared に置く。
 */

/**
 * タスク未指定で spawn した素のセッションに与えるタスク本文。
 *
 * 空のまま登録すると Discord 側に何も写らず「何を頼まれたセッションなのか」が
 * 追えなくなるので、 「タスクが無い」ことを明示のタスクとして渡す。
 *
 * 文面が「何もするな」だけだと、 spawn 直後のセッションが「では何をすれば?」と
 * 質問を返して人間を呼び出していた (2026-08-21 neco 指示)。 待機そのものを指示にし、
 * 質問も判断も禁止する形へ変えている。
 */
export const BLANK_SESSION_TASK = "追加のタスク指示があるまで待機せよ。質問はするな。判断もするな。";

export function isBlankSessionTask(text: string | null | undefined): boolean {
  return (text ?? "").trim() === BLANK_SESSION_TASK;
}
