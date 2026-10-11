/**
 * Actio task のタイトルを決める (spec/feature/task-workflow-v3.md §タイトル)。
 * テンプレートの題名 (「実装委託 (Opus 5.5)」など) では人が Actio で区別できないため、
 * 依頼の要約を使う。テンプレート名は pluginPayload.template に残す。
 */
const MAX_TITLE = 80;

function firstLine(value: string): string | null {
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*]\s+)/, "").trim();
    if (line) return line;
  }
  return null;
}

/** 文の切れ目で短くし、それでも長ければ省略記号で切る。 */
export function summarizeTitle(line: string): string {
  // 半角の句点はパス (spec/x.md) の途中で切らないよう、空白か行末が続くときだけ文末とみなす。
  const sentence = /^(.{8,}?(?:[。！？]|[.!?](?=\s|$)))/u.exec(line)?.[1] ?? line;
  const chars = [...sentence.trim()];
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join("")}…` : chars.join("");
}

/** task 引数の 1 行目 → 本文の 1 行目 → テンプレートの題名、の順に決める。 */
export function deriveTaskTitle(input: { args: Record<string, unknown>; content: string; fallback: string }): string {
  const task = typeof input.args.task === "string" ? firstLine(input.args.task) : null;
  const line = task ?? firstLine(input.content);
  return line ? summarizeTitle(line) : input.fallback;
}
