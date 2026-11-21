export default {
  post(result: string, duplicate: boolean, enabled: boolean, breaker: { status: string }): boolean {
    if (duplicate) return result === "duplicate";
    if (!enabled) return result === "disabled";
    if (breaker.status === "OPEN") return result === "breaker_open";
    return result === "queued";
  },
};
