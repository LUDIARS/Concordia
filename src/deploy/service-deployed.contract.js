/** Contract predicates share one module because they observe one notification boundary. */
export default {
  post(result) {
    if (typeof result === "string") return result.length > 0;
    if (!result || typeof result !== "object") return false;
    if (Array.isArray(result.targets)) return typeof result.hqCount === "number" && result.targets.length >= result.hqCount;
    return Array.isArray(result.delivered) && Array.isArray(result.failed);
  },
};
