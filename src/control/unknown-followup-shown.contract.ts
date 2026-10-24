/** @implements spec/feature/task-linked-followup.md — actio-link-C-3 同じ unknown だけを抑止する */
/** C-3: suppression happens only when the key is non-null and equals the shown key. */
export default {
  post(result: unknown, key: unknown, shown: unknown): boolean {
    return result === (key !== null && key !== undefined && key === shown);
  },
};
