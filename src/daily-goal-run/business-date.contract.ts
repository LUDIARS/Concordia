/** @implements spec/feature/daily-goal-run.md — 用語 (その日 = 朝 4:00 から翌朝 4:00) */
/** The business date starts at its boundary and the given time lies before the next day's boundary. */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const now = args[0];
    const boundary = String(args[1] ?? "04:00");
    if (typeof result !== "string" || typeof now !== "number" || !/^\d{4}-\d{2}-\d{2}$/.test(result)) return false;
    const match = /^(\d{1,2}):(\d{2})$/.exec(boundary.trim());
    const hour = match && Number(match[1]) <= 23 ? Number(match[1]) : 4;
    const minute = match && Number(match[2]) <= 59 ? Number(match[2]) : 0;
    const [y, m, d] = result.split("-").map(Number);
    const start = new Date(y!, m! - 1, d!, hour, minute).getTime();
    const end = new Date(y!, m! - 1, d! + 1, hour, minute).getTime();
    return start <= now && now < end;
  },
};
