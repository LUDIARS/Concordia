/** @implements spec/feature/daily-goal-run.md — 6. 十分にこなした (CC-DG-INV-06) */
/**
 * The exhausted report is accepted only for a non-empty remainder where no item is doable,
 * every unachievable item has a reason, and every human-judgment item maps to an existing
 * unanswered question or active human wait.
 */
type Item = { item: string; class: string; reason?: string; questionId?: number; humanWait?: boolean };

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const remaining = (args[0] ?? []) as Item[];
    const exists = args[1] as ((item: Item) => boolean) | undefined;
    const r = result as { accepted?: unknown; reason?: unknown } | null;
    if (!r || typeof r.accepted !== "boolean" || !exists) return false;
    if (remaining.some((i) => i.class === "doable")) return r.accepted === false && r.reason === "doable_remaining";
    const valid = remaining.length > 0 && remaining.every((i) => i.item.trim() !== "" && (
      i.class === "unachievable" ? !!i.reason?.trim()
        : i.class === "human_judgment" ? (i.questionId !== undefined || i.humanWait === true) && exists(i) : false));
    return r.accepted === valid;
  },
};
