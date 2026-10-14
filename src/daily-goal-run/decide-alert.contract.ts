/** @implements spec/feature/daily-goal-run.md — 5. 不調の通知 (CC-DG-INV-07 / CC-DG-INV-12) */
/**
 * Only "behind" / "stalled" notify. One streak notifies at most twice: at its start and once
 * after three hours. "on_track" clears the streak; a failed judgment (null) changes nothing.
 */
interface State { streakSince: number | null; count: number }

const REALERT_MS = 3 * 60 * 60_000;

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const state = args[0] as State | undefined;
    const verdict = args[1] as string | null | undefined;
    const now = args[2] as number;
    const r = result as { notify?: unknown; next?: State } | null;
    if (!state || !r || !r.next) return false;
    if (verdict === null || verdict === undefined) {
      return r.notify === false && r.next.streakSince === state.streakSince && r.next.count === state.count;
    }
    if (verdict === "on_track") return r.notify === false && r.next.streakSince === null && r.next.count === 0;
    if (state.streakSince === null) return r.notify === true && r.next.streakSince === now && r.next.count === 1;
    const repeat = state.count === 1 && now - state.streakSince >= REALERT_MS;
    return repeat
      ? r.notify === true && r.next.count === 2 && r.next.streakSince === state.streakSince
      : r.notify === false && r.next.count === state.count && r.next.streakSince === state.streakSince;
  },
};
