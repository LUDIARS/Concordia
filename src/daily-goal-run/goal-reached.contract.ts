/** @implements spec/feature/daily-goal-run.md — 6. ゴール到達 (CC-DG-INV-03) */
/** Reached only when every acceptance item has at least one Cc-verified evidence key. */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const acceptance = (args[0] ?? []) as string[];
    const byItem = args[1] as ReadonlyMap<string, readonly string[]> | undefined;
    const r = result as { reached?: unknown; missing?: unknown } | null;
    if (!r || !byItem) return false;
    const missing = acceptance.filter((item) => (byItem.get(item)?.length ?? 0) === 0);
    const reached = acceptance.length > 0 && missing.length === 0;
    return reached ? r.reached === true : r.reached === false && JSON.stringify(r.missing) === JSON.stringify(missing);
  },
};
