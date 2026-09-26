/** @implements spec/feature/domain-review-discord.md §8 — 投稿一覧の事後条件 */
/**
 * Contract predicates share one module because they observe one read boundary:
 * C-10 on the list (newest first, capped, code-filtered) and C-11 on each summary
 * (only the listed fields, never the report body). The field set and the cap are
 * spelled out here rather than imported so the predicate states the spec instead
 * of echoing the implementation it checks.
 */
const SUMMARY_FIELDS = [
  "code", "coreDomains", "id", "layerViolations", "layers",
  "planQuestions", "postedAt", "repoOrigin", "source", "trigger",
];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function isSummary(value: unknown): value is { id: number; code: string; postedAt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value).sort();
  return fields.length === SUMMARY_FIELDS.length && fields.every((field, index) => field === SUMMARY_FIELDS[index]);
}

/** The requested cap as the spec reads it: blank or non-numeric means the default. */
function requestedCap(limit: unknown): number {
  const text = typeof limit === "number" ? String(limit) : typeof limit === "string" ? limit.trim() : "";
  const value = text ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

function isNewestFirst(items: ReadonlyArray<{ id: number; postedAt: string }>): boolean {
  return items.every((item, index) => {
    if (index === 0) return true;
    const previous = items[index - 1]!;
    const gap = Date.parse(previous.postedAt) - Date.parse(item.postedAt);
    return gap > 0 || (gap === 0 && previous.id > item.id);
  });
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!Array.isArray(result)) return isSummary(result);
    const query = args[1] as { code?: unknown; limit?: unknown } | undefined;
    const code = typeof query?.code === "string" ? query.code : null;
    return result.length <= requestedCap(query?.limit)
      && result.every(isSummary)
      && (code === null || result.every((item) => item.code === code))
      && isNewestFirst(result);
  },
};
