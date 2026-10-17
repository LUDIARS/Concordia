/** @implements spec/feature/task-workflow-v3.md CC-AT-PAGE-02 */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const page = args[0] as { nextCursor?: unknown } | undefined;
    const next = page?.nextCursor;
    return typeof next === "string" && next.length > 0 ? result === next : result === null;
  },
};
