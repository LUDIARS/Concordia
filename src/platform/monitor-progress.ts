import { contract } from './ontime-runtime.js'; /* augur-inject:import:d27a6e53 */
import augurContract_f00685c6 from './monitor-progress.contract.js'; /* augur-inject:contract-predicate:7b52379f */
/** A reported estimate is evidence, never a completion decision or permission. */
export interface MonitorProgress {
  task: string;
  percent: number;
  evidence: string;
  remaining: string[];
  complete: boolean;
  at: string;
}

export function readMonitorProgress(text: string, task: string | null, now: number): MonitorProgress | null {
  if (text.length > 64_000) return null;
  const matches = [...text.matchAll(/^```cc-progress\r?\n([^]*?)\r?\n```/gm)];
  const match = matches.at(-1);
  if (!match || !task) return null;
  try {
    const r = JSON.parse(match[1]) as MonitorProgress;
    if (!r || r.task !== task || typeof r.percent !== "number" || !Number.isFinite(r.percent)
      || r.percent < 0 || r.percent > 100 || typeof r.evidence !== "string" || !r.evidence.trim()
      || r.evidence.length > 1000 || typeof r.complete !== "boolean"
      || !Array.isArray(r.remaining) || r.remaining.length > 100 || !r.remaining.every(x => typeof x === "string" && x.length <= 1000)
      || typeof r.at !== "string") return null;
    const age = now - Date.parse(r.at);
    if (!Number.isFinite(age) || age < 0 || age > 30 * 60_000) return null;
    if (r.percent === 100 && (!r.complete || r.remaining.length > 0)) return null;
    return r;
  } catch { return null; }
}
// @ts-expect-error augur-inject
readMonitorProgress = contract(readMonitorProgress, { ...augurContract_f00685c6, contractId: 'monitor-C-1', mode: 'observe', sample: 1, where: 'src/platform/monitor-progress.ts:11', rule: 'contract-wrap', id: 'f00685c6' }); /* augur-inject:contract-wrap:f00685c6 */
