/** @implements spec/feature/package-update-events.md — パッケージ更新お知らせ境界の事後条件 */
/** Contract predicates for the package update notice boundary. */
export default {
  post(result: unknown): boolean {
    // neutralizePackageUpdateText: mention になりうる並びが残らない。
    if (typeof result === "string") return !/@(everyone|here)\b|<[@#&!]|<:[a-z]+:/i.test(result);
    if (!result || typeof result !== "object") return false;
    const shape = result as { delivered?: unknown; failed?: unknown; duplicate?: unknown };
    // handlePackageUpdates: duplicate なら何も配送しておらず、 失敗は配送済みに数えない。
    return typeof shape.delivered === "number"
      && Array.isArray(shape.failed)
      && typeof shape.duplicate === "boolean"
      && !(shape.duplicate === true && (shape.delivered > 0 || shape.failed.length > 0));
  },
};
