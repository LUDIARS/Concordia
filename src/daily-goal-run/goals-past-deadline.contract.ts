/** @implements spec/feature/daily-goal-run.md — 6. 締切 (翌朝 4:00) / CC-DG-INV-05 */
/** Only active goals whose deadline (next day's boundary) has passed are returned. */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const goals = (args[0] ?? []) as Array<{ id: string; date: string; status: string }>;
    const now = args[1] as number;
    const boundary = String(args[2] ?? "04:00");
    if (!Array.isArray(result)) return false;
    const match = /^(\d{1,2}):(\d{2})$/.exec(boundary.trim());
    const hour = match && Number(match[1]) <= 23 ? Number(match[1]) : 4;
    const minute = match && Number(match[2]) <= 59 ? Number(match[2]) : 0;
    const expected = goals.filter((goal) => {
      const [y, m, d] = goal.date.split("-").map(Number);
      const deadline = new Date(y!, m! - 1, d! + 1, hour, minute).getTime();
      return (goal.status === "confirmed" || goal.status === "running") && now >= deadline;
    }).map((goal) => goal.id);
    return JSON.stringify((result as Array<{ id: string }>).map((goal) => goal.id)) === JSON.stringify(expected);
  },
};
