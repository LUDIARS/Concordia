/** @implements spec/feature/daily-goal-run.md — 8. 日のまとめ / CC-DG-INV-10 */
/** No summary for a day without goals that declared no goal or has no drafts; otherwise one section per goal. */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as { goals: Array<{ goal: { goalText: string } }>; drafts: unknown[]; noGoal: boolean };
    const skip = input.goals.length === 0 && (input.noGoal || input.drafts.length === 0);
    if (skip) return result === null;
    const r = result as { title?: unknown; markdown?: unknown } | null;
    if (!r || typeof r.title !== "string" || typeof r.markdown !== "string") return false;
    return input.goals.every(({ goal }) => (r.markdown as string).includes(goal.goalText));
  },
};
