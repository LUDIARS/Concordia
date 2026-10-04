/** C-15: unavailable classification blocks without assigning a violation penalty. */
export default {
  post(result: unknown, reason: unknown): boolean {
    const decision = result as { blocked?: boolean; penaltyEligible?: boolean; reason?: unknown };
    return decision?.reason === reason && decision.blocked === (reason !== null)
      && decision.penaltyEligible === (reason === "personal_data" || reason === "confidential_data");
  },
};
