/** @implements spec/feature/task-linked-followup.md — actio-link-C-2 unknown の鍵 */
/** C-2: the key is null for every state other than unknown and a non-empty string for unknown. */
export default {
  post(result: unknown, state: unknown): boolean {
    return state === "unknown" ? typeof result === "string" && result.length > 0 : result === null;
  },
};
