import type { DecisionRecord, Rule, RuleState } from './types.js';
export interface DomainStats {
    domain: string;
    /** 集計対象にした直近判断数。 */
    window: number;
    ruleDecisions: number;
    llmDecisions: number;
    /** ルール由来の割合 0..1。 1.0 = 完全卒業。 判断が無ければ 0。 */
    ruleCoverage: number;
    /** verdict 待ちの判断数 (レビューキューの深さ)。 */
    pendingReview: number;
    ruleStates: Record<RuleState, number>;
}
export declare function domainStats(domain: string, recent: DecisionRecord[], rules: Rule[]): DomainStats;
//# sourceMappingURL=stats.d.ts.map