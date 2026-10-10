/** @implements spec/feature/daily-goal-run.md — 5. 確認 / 予算 (CC-DG-INV-03 / CC-DG-INV-05 / CC-DG-INV-07) */
/**
 * While waiting nothing is sent and the budget is untouched. Otherwise progress is declared
 * only when the evidence snapshot contains a key the previous one did not (or a task status
 * changed), and only progress resets the budget. No progress never stops the goal.
 */
interface Snapshot { items: Array<{ key: string }>; taskStatuses: Record<string, string> }

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as { waiting: boolean; previous: Snapshot | null; current: Snapshot } | undefined;
    const r = result as { action?: unknown; resetBudget?: unknown; newEvidence?: unknown } | null;
    if (!input || !r) return false;
    if (input.waiting) return r.action === "skip_waiting" && r.resetBudget === undefined;
    const known = new Set(input.previous?.items.map((i) => i.key) ?? []);
    const added = input.current.items.some((i) => !known.has(i.key))
      || Object.entries(input.current.taskStatuses).some(([id, status]) => {
        const before = input.previous?.taskStatuses[id];
        return status !== "unknown" && before !== undefined && before !== "unknown" && before !== status;
      });
    return added
      ? r.action === "progress" && r.resetBudget === true && Array.isArray(r.newEvidence) && r.newEvidence.length > 0
      : r.action === "completion" && r.resetBudget === false;
  },
};
