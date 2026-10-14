/** @implements spec/feature/daily-goal-run.md — 4. 1 時間ごとのワンショット確認 (CC-DG-INV-03) */
/**
 * A judgment survives only with a known verdict. Every kept evidence ref exists in the
 * collected snapshot, and no acceptance item is "reached" without at least one such ref.
 */
interface Snapshot { items: Array<{ key: string }> }

const VERDICTS = new Set(["on_track", "behind", "stalled"]);

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const raw = args[0] as { verdict?: unknown } | null | undefined;
    const acceptance = (args[1] ?? []) as string[];
    const evidence = args[2] as Snapshot | undefined;
    if (!evidence) return false;
    const r = result as { verdict?: unknown; acceptance?: Array<{ item: string; outlook: string; refs: string[] }> } | null;
    if (!raw || typeof raw !== "object" || !VERDICTS.has(String(raw.verdict))) return r === null;
    if (r === null) return true; // other shape problems may still reject the judgment
    if (!VERDICTS.has(String(r.verdict)) || !Array.isArray(r.acceptance) || r.acceptance.length !== acceptance.length) return false;
    const known = new Set(evidence.items.map((item) => item.key));
    return r.acceptance.every((entry, index) => entry.item === acceptance[index]
      && entry.refs.every((ref) => known.has(ref))
      && (entry.outlook !== "reached" || entry.refs.length > 0));
  },
};
