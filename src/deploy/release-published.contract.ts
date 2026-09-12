/** @implements spec/feature/release-published-notify.md — 通知境界の事後条件 */
/** Contract predicates for the release-published notification boundary. */
export default {
  post(result: unknown): boolean {
    if (typeof result === "string") return result.trim().length > 0;
    if (!result || typeof result !== "object") return false;
    const shape = result as {
      content?: unknown; shouldDeliver?: unknown;
      duplicate?: unknown; unconfigured?: unknown; delivered?: unknown; failed?: unknown;
    };
    if ("shouldDeliver" in shape) {
      return typeof shape.content === "string" && typeof shape.shouldDeliver === "boolean";
    }
    return typeof shape.duplicate === "boolean"
      && typeof shape.unconfigured === "boolean"
      && typeof shape.delivered === "boolean"
      && (typeof shape.failed === "string" || shape.failed === null);
  },
};
