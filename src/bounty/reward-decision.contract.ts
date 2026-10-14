/** @implements SPEC-BOUNTY-REWARD */
/** C-4: request a reward only for an accepted, non-duplicate, not self-inflicted report with a non-HQ recipient. */
export default {
  post(
    result: unknown,
    input: { verdict?: unknown; duplicateOf?: unknown; selfInflicted?: unknown; recipient?: { subsidiaryId?: unknown } | null } | undefined,
  ): boolean {
    if (!result || typeof result !== "object") return false;
    const decision = result as { request?: unknown; reason?: unknown };
    const eligible = input?.verdict === "accepted"
      && (input.duplicateOf === null || input.duplicateOf === undefined)
      && input.selfInflicted !== true
      && !!input.recipient
      && typeof input.recipient.subsidiaryId === "string";
    if (eligible) return decision.request === true;
    return decision.request === false && typeof decision.reason === "string" && decision.reason.length > 0;
  },
};
