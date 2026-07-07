// ルールのライフサイクル遷移 (candidate → trial → auto / retired)。 純粋関数のみ。
//
// 遷移の全条件をここに集約する。 engine はこの関数の出力 (patch) を store に書くだけ。

import type { Rule, RulePatch, RuleState } from './types.js';

export interface Thresholds {
  /** trial ルールへの人間 OK がこの数に達すると auto (卒業)。 */
  autoPromote: number;
  /** 人間 NG がこの数に達すると retired (撤回)。 */
  autoRetract: number;
  /** candidate の影一致がこの数に達する (かつ衝突 0) と trial へ昇格。 */
  shadowPromote: number;
  /** candidate の影衝突がこの数に達すると retired (筋の悪い候補の自動間引き)。 */
  shadowConflictLimit: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  autoPromote: 3,
  autoRetract: 3,
  shadowPromote: 3,
  shadowConflictLimit: 2,
};

/** 影評価カウンタの増減から candidate の次状態を含む patch を作る。 candidate 以外は無変更。 */
export function shadowPatch(
  rule: Rule,
  delta: { agreements?: number; conflicts?: number },
  t: Thresholds,
): RulePatch | null {
  if (rule.state !== 'candidate') return null;
  const agreements = Math.max(0, rule.shadowAgreements + (delta.agreements ?? 0));
  const conflicts = Math.max(0, rule.shadowConflicts + (delta.conflicts ?? 0));
  return {
    shadowAgreements: agreements,
    shadowConflicts: conflicts,
    state: candidateStateFor(agreements, conflicts, t),
  };
}

function candidateStateFor(agreements: number, conflicts: number, t: Thresholds): RuleState {
  if (conflicts >= t.shadowConflictLimit) return 'retired';
  if (conflicts === 0 && agreements >= t.shadowPromote) return 'trial';
  return 'candidate';
}

/** 人間の OK/NG によるルールの patch。 OK は trial→auto を、 NG は →retired を進める。 */
export function verdictPatch(rule: Rule, verdict: 'ok' | 'ng', t: Thresholds): RulePatch {
  if (verdict === 'ok') {
    const approvals = rule.approvals + 1;
    const graduated = rule.state === 'trial' && approvals >= t.autoPromote;
    return { approvals, state: graduated ? 'auto' : rule.state };
  }
  const rejections = rule.rejections + 1;
  return { rejections, state: rejections >= t.autoRetract ? 'retired' : rule.state };
}

/** 発火対象 (live) のルールか。 */
export function isLive(state: RuleState): boolean {
  return state === 'trial' || state === 'auto';
}
