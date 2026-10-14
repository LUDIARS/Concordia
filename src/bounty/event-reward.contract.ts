/** @implements SPEC-BOUNTY-REWARD */
/**
 * C-3: the reward override is null unless there is an event, a severity, and an override for that severity;
 * otherwise it is exactly that severity's value (spec/feature/bug-bounty.md §18.4).
 */
export default {
  post(
    result: unknown,
    event: { rewardOverride?: Record<string, unknown> | null } | null | undefined,
    severity: unknown,
  ): boolean {
    const override = event?.rewardOverride ?? null;
    const value = override && typeof severity === "string" ? override[severity] : undefined;
    if (typeof value !== "number") return result === null;
    return result === value;
  },
};
