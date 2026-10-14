/** @implements SPEC-FED-SITE-ACTIVITY */
/** site-activity-prs-C-2: the built report fits the byte budget and the PR caps, and keeps the total count. */
interface Pr { number: number }
interface Session { prs?: Pr[] }
interface Report { session_count: number; sessions: Session[] }


export default {
  post(result: unknown, _date: string, sessions: readonly unknown[], _now?: number, _limit?: number, _prsOf?: unknown, maxBytes?: number): boolean {
    const report = result as Report | null;
    if (!report || !Array.isArray(report.sessions) || report.session_count !== sessions.length) return false;
    const bytes = Buffer.byteLength(JSON.stringify({ v: 1, type: "activity-report", ...report }), "utf8");
    if (bytes > (maxBytes ?? 48 * 1024)) return false;
    let total = 0;
    for (const s of report.sessions) {
      const n = s.prs?.length ?? 0;
      if (n > 5) return false;
      total += n;
    }
    return total <= 120;
  },
};
