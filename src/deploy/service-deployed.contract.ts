/** @implements spec/feature/service-deployed-notify.md — 通知境界の事後条件 */
/** Contract predicates share one module because they observe one notification boundary. */
export default {
  post(result: unknown): boolean {
    if (typeof result === "string") return result.length > 0;
    if (!result || typeof result !== "object") return false;
    const shape = result as { targets?: unknown; hqCount?: unknown; delivered?: unknown; failed?: unknown };
    if (Array.isArray(shape.targets)) return typeof shape.hqCount === "number" && shape.targets.length >= shape.hqCount;
    return Array.isArray(shape.delivered) && Array.isArray(shape.failed);
  },
};
