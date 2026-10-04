/** @implements SPEC-BOUNTY-INTAKE */
/**
 * C-3: a report without "what happened" is still accepted, as needs_info; everything else
 * starts at received (spec/feature/bug-bounty.md §3). The target project may be unknown.
 */
export default {
  post(result: unknown, fields: { what_happened?: unknown } | undefined): boolean {
    const blank = typeof fields?.what_happened !== "string" || fields.what_happened.trim().length === 0;
    return result === (blank ? "needs_info" : "received");
  },
};
