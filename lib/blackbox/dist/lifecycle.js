// ルールのライフサイクル遷移 (candidate → trial → auto / retired)。 純粋関数のみ。
//
// 遷移の全条件をここに集約する。 engine はこの関数の出力 (patch) を store に書くだけ。
export const DEFAULT_THRESHOLDS = {
    autoPromote: 3,
    autoRetract: 3,
    shadowPromote: 3,
    shadowConflictLimit: 2,
};
/** 影評価カウンタの増減から candidate の次状態を含む patch を作る。 candidate 以外は無変更。 */
export function shadowPatch(rule, delta, t) {
    if (rule.state !== 'candidate')
        return null;
    const agreements = Math.max(0, rule.shadowAgreements + (delta.agreements ?? 0));
    const conflicts = Math.max(0, rule.shadowConflicts + (delta.conflicts ?? 0));
    return {
        shadowAgreements: agreements,
        shadowConflicts: conflicts,
        state: candidateStateFor(agreements, conflicts, t),
    };
}
function candidateStateFor(agreements, conflicts, t) {
    if (conflicts >= t.shadowConflictLimit)
        return 'retired';
    if (conflicts === 0 && agreements >= t.shadowPromote)
        return 'trial';
    return 'candidate';
}
/** 人間の OK/NG によるルールの patch。 OK は trial→auto を、 NG は →retired を進める。 */
export function verdictPatch(rule, verdict, t) {
    if (verdict === 'ok') {
        const approvals = rule.approvals + 1;
        const graduated = rule.state === 'trial' && approvals >= t.autoPromote;
        return { approvals, state: graduated ? 'auto' : rule.state };
    }
    const rejections = rule.rejections + 1;
    return { rejections, state: rejections >= t.autoRetract ? 'retired' : rule.state };
}
/** 発火対象 (live) のルールか。 */
export function isLive(state) {
    return state === 'trial' || state === 'auto';
}
//# sourceMappingURL=lifecycle.js.map