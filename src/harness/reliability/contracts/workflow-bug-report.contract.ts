// @spec ハーネス信頼性の実装境界
/** @implements SPEC-BOUNTY-GUIDANCE */
/**
 * bounty-event C-4: the bug-bounty route appears only when open bounty events are passed in, and then only
 * next to a bug-report route. The bug-report route names the ordinary report skill (`bug-report`, Actio) and
 * nothing else to act on; neither route files a report (spec/feature/bug-bounty.md §8.1 §18.5).
 */
export default {
  post(
    result: unknown,
    _prompt: unknown,
    _tags: unknown,
    options: { openBountyEvents?: readonly unknown[] } | undefined,
  ): boolean {
    if (!Array.isArray(result)) return false;
    const bounty = result.filter((item) => item?.kind === "bug-bounty");
    const report = result.filter((item) => item?.kind === "bug-report");
    const open = options?.openBountyEvents ?? [];
    if (bounty.length > 0 && (open.length === 0 || report.length !== 1)) return false;
    return report.length <= 1 && report.every((route) =>
      route.skill === "bug-report" && route.source === "deterministic"
      && typeof route.advice === "string" && route.advice.includes("bug-report")
      && route.advice.includes("自動で出さない"));
  },
};
