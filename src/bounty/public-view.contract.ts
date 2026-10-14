/** @implements SPEC-BOUNTY-PUBLIC */
/** C-5: publish only accepted reports of public projects; sensitive ones only after deployment. */
const ACCEPTED = ["accepted", "fix_pending", "fixing", "fix_submitted", "deployed"];

export default {
  post(
    result: unknown,
    input: { projectPublic?: unknown; verdict?: unknown; status?: unknown; sensitive?: unknown } | undefined,
  ): boolean {
    if (typeof result !== "boolean") return false;
    const expected = input?.projectPublic === true
      && input.verdict === "accepted"
      && ACCEPTED.includes(String(input.status))
      && (input.sensitive !== true || input.status === "deployed");
    return result === expected;
  },
};
