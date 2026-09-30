/**
 * 会話への人間入力の意図判定 (純関数)。
 *
 * - 「次の作業」: 人間が直接書いた先頭行だけで判定する。 引用 (`>`)・コードブロック内・
 *   文中の言及では起動しない。 ツール出力や AI の発言は ingress が人間投稿以外を
 *   通さないため、ここへは来ない。
 * - 停止・取消: 通常作業より優先して扱う短い指示。
 *
 * @implements spec/feature/astra-with-sidecar.md §会話と実行の寿命
 */

export type ConversationInputIntent =
  | { kind: "next_work"; instruction: string }
  | { kind: "stop" }
  | { kind: "cancel" }
  | { kind: "work" };

const NEXT_WORK_HEAD = /^(?:\/next-work|次の(?:作業|タスク))(?:へ|に)?(?:移(?:って|る|ります)|進(?:んで|む|みます))?(?:ください|下さい|お願い(?:します)?)?(?=$|[\s:：。、!！])/u;
const NEGATION = /(しないで|しない|せず|不要|やめて|まだ|待って)/u;
const STOP = /^(?:\/stop|停止|止めて|ストップ)(?:して(?:ください)?|します)?[。!！]?$/u;
const CANCEL = /^(?:\/cancel|取消|取り消し|キャンセル|中止)(?:して(?:ください)?|します)?[。!！]?$/u;

/** 引用行とコードブロックを除いた、人間が直接書いた行。 */
export function directLines(text: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || line.startsWith(">")) continue;
    lines.push(line);
  }
  return lines;
}

export function classifyConversationInput(text: string): ConversationInputIntent {
  const lines = directLines(text);
  const head = lines[0] ?? "";
  if (lines.length === 1 && STOP.test(head.replace(/\s+/g, ""))) return { kind: "stop" };
  if (lines.length === 1 && CANCEL.test(head.replace(/\s+/g, ""))) return { kind: "cancel" };
  const match = NEXT_WORK_HEAD.exec(head);
  if (match && !NEGATION.test(head)) {
    const rest = [head.slice(match[0].length).replace(/^[\s:：。、]+/u, ""), ...lines.slice(1)]
      .filter(Boolean)
      .join("\n")
      .trim();
    return { kind: "next_work", instruction: rest };
  }
  return { kind: "work" };
}
