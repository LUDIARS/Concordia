/** @implements CC-RV-LIST-SCOPE-01 */
/**
 * C-3: the #2263 listing keeps every summary row in order, shows open PRs in full,
 * and falls back to the open PRs alone when the summary is unavailable.
 */
type Row = { id?: unknown };

export default {
  post(result: unknown, summaries?: unknown, openDetails?: unknown): boolean {
    if (!Array.isArray(result) || !Array.isArray(openDetails)) return false;
    const open = new Map((openDetails as Row[]).map((row) => [row.id, row]));
    const rows = result as Row[];
    if (!Array.isArray(summaries)) return rows.length === open.size && rows.every((row) => open.get(row.id) === row);
    const summaryIds = (summaries as Row[]).map((row) => row.id);
    const head = rows.slice(0, summaryIds.length);
    return head.every((row, i) => row.id === summaryIds[i] && (!open.has(row.id) || open.get(row.id) === row))
      && rows.slice(summaryIds.length).every((row) => open.get(row.id) === row);
  },
};
