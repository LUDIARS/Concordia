/** @implements spec/feature/daily-goal-run.md — 7. 9:00 の通知 / CC-DG-INV-11 */
/** Notify only once, between the reminder time and the deadline, on a day without goals, drafts or a no-goal declaration. */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const i = args[0] as { now: number; reminderAt: number; deadlineAt: number; reminderState: string; hasGoal: boolean; hasDraft: boolean; noGoal: boolean };
    const notify = i.reminderState === "none" && !i.hasGoal && !i.hasDraft && !i.noGoal && i.now >= i.reminderAt && i.now < i.deadlineAt;
    return result === (notify ? "notify" : "skip");
  },
};
