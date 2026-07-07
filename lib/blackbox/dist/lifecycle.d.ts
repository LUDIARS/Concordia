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
export declare const DEFAULT_THRESHOLDS: Thresholds;
/** 影評価カウンタの増減から candidate の次状態を含む patch を作る。 candidate 以外は無変更。 */
export declare function shadowPatch(rule: Rule, delta: {
    agreements?: number;
    conflicts?: number;
}, t: Thresholds): RulePatch | null;
/** 人間の OK/NG によるルールの patch。 OK は trial→auto を、 NG は →retired を進める。 */
export declare function verdictPatch(rule: Rule, verdict: 'ok' | 'ng', t: Thresholds): RulePatch;
/** 発火対象 (live) のルールか。 */
export declare function isLive(state: RuleState): boolean;
//# sourceMappingURL=lifecycle.d.ts.map