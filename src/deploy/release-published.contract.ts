/** @implements spec/feature/release-published-notify.md — 通知境界の事後条件 */
/** Contract predicates for the release-published notification boundary. */
export default {
  post(result: unknown): boolean {
    if (typeof result === "string") return result.trim().length > 0;
    if (!result || typeof result !== "object") return false;
    const shape = result as {
      duplicate?: unknown; unconfigured?: unknown; delivered?: unknown; failed?: unknown;
    };
    // 宛先が複数 (本社 + 子会社) になったので、 配送結果は件数ではなく宛先ごとに残る。
    // 「1 つも解決できなかった」 と 「解決したが全部落ちた」 を区別できるようにする。
    return typeof shape.duplicate === "boolean"
      && typeof shape.unconfigured === "boolean"
      && Array.isArray(shape.delivered)
      && Array.isArray(shape.failed)
      && !(shape.unconfigured === true && (shape.delivered.length > 0 || shape.failed.length > 0));
  },
};
