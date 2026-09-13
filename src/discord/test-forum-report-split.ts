/**
 * 審査レポートの本文を Discord の添付に収まる単位へ分ける。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */

/** Each UTF-8 attachment remains comfortably below Discord's normal upload limit. */
export function splitReviewText(text: string, limit = 500_000): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError("Review text limit must be at least 2");
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push(text.slice(start, end));
    start = end;
  }
  return result.length ? result : [""];
}
