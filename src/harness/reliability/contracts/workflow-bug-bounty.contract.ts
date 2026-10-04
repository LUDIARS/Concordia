// @spec ハーネス信頼性の実装境界
/** @implements SPEC-BOUNTY-GUIDANCE */
/**
 * C-8: the bug-bounty route is guidance only. It never appears for automatic control packets,
 * when the human says not to report, or for an input that neither reports a discovery, names
 * the bounty, nor asks where / wishes to report (a request to fix something and report back is
 * a work report, not a defect report). The English word "bug" counts only as a whole word, so
 * "debug" is not a defect. When the route appears it names the report skill and nothing else
 * to act on (spec/feature/bug-bounty.md §8.1 §16.6).
 */
const AUTOMATIC = /^\[(?:自動確認|Cc Session policy|Cc policy update)\]/;
const DECLINED = /報告(?:は|を)?(?:しない|しなくて|不要|いらない|要らない)/;
const DEFECT = /(?:バグ|不具合|壊れて|動かない|\bbugs?\b)/i;
const EXPLICIT = /(?:バウンティ|\bbounty\b|bug-bounty-report|(?<![\w/.-])\/bug\b(?![\w/.-]))/i;
const DISCOVERY = /(?:見つけ|見付け|発見|\bfound\b)/i;
const REPORT_WISH = /(?:どこ(?:に|へ|で)|どうやって)[^。\n]{0,20}報告|報告(?:したい|できる|できます|できない|先|する(?:に|場所|方法))|\bwhere\b[^.\n]{0,30}\breport\b|\b(?:want|like|how) to report\b/i;

export default {
  post(result: unknown, prompt: string): boolean {
    if (!Array.isArray(result)) return false;
    const routes = result.filter((item) => item?.kind === "bug-bounty");
    const text = String(prompt ?? "").replace(/```[\s\S]*?```/g, "").trim();
    if (AUTOMATIC.test(text) || DECLINED.test(text)) return routes.length === 0;
    const explicit = EXPLICIT.test(text);
    const signalled = DEFECT.test(text) && (DISCOVERY.test(text) || REPORT_WISH.test(text));
    if (!explicit && !signalled) return routes.length === 0;
    return routes.length <= 1 && routes.every((route) =>
      route.skill === "bug-bounty-report" && route.source === "deterministic"
      && typeof route.advice === "string" && route.advice.includes("bug-bounty-report"));
  },
};
