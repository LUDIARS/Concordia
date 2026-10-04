/** @implements SPEC-BOUNTY-REPORTER */
/**
 * C-7: an unset public name shows as 匿名, and a session report shows as
 * "AI セッション (依頼者: <公開名 or 匿名>)" (spec/feature/bug-bounty.md §4).
 */
const ANONYMOUS = "匿名";

export default {
  post(result: unknown, input: { kind?: unknown; publicName?: unknown } | undefined): boolean {
    const name = typeof input?.publicName === "string" && input.publicName.trim() ? input.publicName.trim() : ANONYMOUS;
    return result === (input?.kind === "session" ? `AI セッション (依頼者: ${name})` : name);
  },
};
