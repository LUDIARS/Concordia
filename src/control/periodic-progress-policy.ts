import { contract } from './ontime-runtime.js'; /* augur-inject:import:d9f1be91 */
import augurContract_44fa4ed5 from './periodic-progress-policy.contract.js'; /* augur-inject:contract-predicate:5fef6f59 */
/** @implements spec/feature/periodic-progress-report.md — autonomous-continuation policy. */
export interface ProgressRequestInput {
  hasScope: boolean;
  enabled: boolean;
  stopped: boolean;
  budgetSuspended: boolean;
  continuationCount: number;
  maxContinuations: number;
  startedAtSec: number | null;
  maxRuntimeSec: number;
  lastContactMs: number | null;
  nowMs: number;
  intervalMs: number;
}

/** Activity determines acknowledgement elsewhere; it never estimates completion. */
export function shouldRequestProgress(input: ProgressRequestInput): boolean {
  if (!input.hasScope || !input.enabled || input.stopped || input.budgetSuspended) return false;
  if (input.continuationCount >= input.maxContinuations) return false;
  if (input.startedAtSec !== null && input.nowMs / 1000 - input.startedAtSec >= input.maxRuntimeSec) return false;
  return input.lastContactMs === null || input.nowMs - input.lastContactMs >= input.intervalMs;
}
// @ts-expect-error augur-inject
shouldRequestProgress = contract(shouldRequestProgress, { ...augurContract_44fa4ed5, contractId: 'periodic-progress-C-1', mode: 'observe', sample: 1, where: 'src/control/periodic-progress-policy.ts:17', rule: 'contract-wrap', id: '44fa4ed5' }); /* augur-inject:contract-wrap:44fa4ed5 */

/** Default complete mode is not an explicit goal. Run identity comes from the delegation owner. */
export function progressScope(metadata: string | null, activeRunId: string | null): string | null {
  if (activeRunId) return `run:${activeRunId}`;
  try {
    const goal: unknown = (JSON.parse(metadata ?? "{}") as Record<string, unknown>).goal;
    if (!goal || typeof goal !== "object") return null;
    const value = goal as { mode?: unknown; text?: unknown };
    return ["complete", "scoped"].includes(String(value.mode)) ? `goal:${JSON.stringify(goal)}` : null;
  } catch { return null; }
}
