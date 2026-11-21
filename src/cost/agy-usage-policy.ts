import type { AgyGeneration } from "./agy-usage-metadata.js";
import type { Totals } from "./log-usage.js";
import type { UsageWindow } from "./windowed-usage.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:f609f457 */
import augurContract_e5759f9c from './agy-usage-policy.contract.js'; /* augur-inject:contract-predicate:90db15e3 */
import augurContract_8b8f1626 from './agy-window.contract.js'; /* augur-inject:contract-predicate:497b8e31 */

export function agySessionGenerations(
  generations: readonly AgyGeneration[],
  start: number,
  end: number,
): AgyGeneration[] {
  return generations.filter(({ atMs }) => atMs !== null && atMs >= start && atMs < end);
}
// @ts-expect-error augur-inject
agySessionGenerations = contract(agySessionGenerations, { ...augurContract_e5759f9c, contractId: 'agy-cost-C-2', mode: 'observe', sample: 1, where: 'src/cost/agy-usage-policy.ts:5', rule: 'contract-wrap', id: 'e5759f9c' }); /* augur-inject:contract-wrap:e5759f9c */

export function accumulateAgyUsageWindows(
  generations: readonly AgyGeneration[],
  windows: readonly UsageWindow[],
): Record<string, number> {
  return Object.fromEntries(windows.map(({ key, startSec, endSec }) => [
    key,
    agySessionGenerations(generations, startSec * 1000, endSec * 1000)
      .reduce((sum, row) => sum + row.total, 0),
  ]));
}
// @ts-expect-error augur-inject
accumulateAgyUsageWindows = contract(accumulateAgyUsageWindows, { ...augurContract_8b8f1626, contractId: 'agy-cost-C-3', mode: 'observe', sample: 1, where: 'src/cost/agy-usage-policy.ts:13', rule: 'contract-wrap', id: '8b8f1626' }); /* augur-inject:contract-wrap:8b8f1626 */

export function totalAgyUsage(generations: readonly AgyGeneration[]): Totals | null {
  const totals: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const row of generations) {
    totals.input += row.input;
    totals.cached += row.cached;
    totals.output += row.output;
    totals.total += row.total;
  }
  return totals.total > 0 ? totals : null;
}
