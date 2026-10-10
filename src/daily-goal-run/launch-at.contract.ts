/** @implements spec/feature/daily-goal-run.md — 3. 起動時刻 (7:30 までの確定は 7:30、以降は確定時) */
/** The launch time is never before the confirmation and never before the configured time on that date. */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const confirmedAt = args[0];
    const date = String(args[1] ?? "");
    const time = String(args[2] ?? "07:30");
    if (typeof result !== "number" || typeof confirmedAt !== "number") return false;
    const [y, m, d] = date.split("-").map(Number);
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    const valid = !!match && Number(match[1]) <= 23 && Number(match[2]) <= 59;
    const hour = valid ? Number(match![1]) : 7;
    const minute = valid ? Number(match![2]) : 30;
    const scheduled = new Date(y!, (m ?? 1) - 1, d ?? 1, hour, minute, 0, 0).getTime();
    return result === Math.max(confirmedAt, scheduled);
  },
};
