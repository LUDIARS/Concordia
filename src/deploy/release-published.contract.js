/** Contract predicates for the release-published notification boundary. */
export default {
  post(result) {
    if (typeof result === "string") return result.trim().length > 0;
    if (!result || typeof result !== "object") return false;
    if ("shouldDeliver" in result) {
      return typeof result.content === "string" && typeof result.shouldDeliver === "boolean";
    }
    return typeof result.duplicate === "boolean"
      && typeof result.unconfigured === "boolean"
      && typeof result.delivered === "boolean"
      && (typeof result.failed === "string" || result.failed === null);
  },
};
