/**
 * 不調の通知を出すかの判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 不調の通知 / CC-DG-INV-07 / CC-DG-INV-12
 *
 * 通知は「遅れ気味」「停滞」のときだけ。 1 続きの不調では最初の 1 回と、 3 時間続いたときの
 * 再通知 1 回まで。 「順調」で続き具合を戻す。 判定できず (null) は何も変えない。
 */

import type { ProgressVerdict } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:bb11da37 */
import augurContract_d2f77bfe from './decide-alert.contract.js'; /* augur-inject:contract-predicate:9b83c42d */

export const REALERT_AFTER_MS = 3 * 60 * 60_000;

export interface AlertState {
  /** 続いている不調の始まり。 不調でなければ null。 */
  streakSince: number | null;
  /** その不調で通知した回数。 */
  count: number;
}

export type AlertDecision =
  | { notify: false; next: AlertState }
  | { notify: true; kind: "first" | "repeat"; next: AlertState };

export function isPoorVerdict(verdict: ProgressVerdict): boolean {
  return verdict === "behind" || verdict === "stalled";
}

export function decideProgressAlert(state: AlertState, verdict: ProgressVerdict | null, now: number): AlertDecision {
  if (verdict === null) return { notify: false, next: { ...state } };
  if (!isPoorVerdict(verdict)) return { notify: false, next: { streakSince: null, count: 0 } };
  if (state.streakSince === null) return { notify: true, kind: "first", next: { streakSince: now, count: 1 } };
  if (state.count === 1 && now - state.streakSince >= REALERT_AFTER_MS) {
    return { notify: true, kind: "repeat", next: { streakSince: state.streakSince, count: 2 } };
  }
  return { notify: false, next: { ...state } };
}
// @ts-expect-error augur-inject
decideProgressAlert = contract(decideProgressAlert, { ...augurContract_d2f77bfe, contractId: 'dg-C-13', mode: 'observe', sample: 1, where: 'src/daily-goal-run/alert-policy.ts:29', rule: 'contract-wrap', id: 'd2f77bfe' }); /* augur-inject:contract-wrap:d2f77bfe */
