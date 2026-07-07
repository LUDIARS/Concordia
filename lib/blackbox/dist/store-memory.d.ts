import type { DecisionLedger, DecisionRecord, Rule, RuleDraft, RulePatch, RuleStore } from './types.js';
export declare class MemoryRuleStore implements RuleStore {
    private readonly now;
    private rules;
    constructor(now?: () => string);
    listByDomain(domain: string): Rule[];
    findByFingerprint(domain: string, fingerprint: string): Rule | null;
    get(id: string): Rule | null;
    insert(draft: RuleDraft): Rule;
    update(id: string, patch: RulePatch): Rule | null;
    /** 直列化用スナップショット (ゲームのセーブデータ等)。 */
    snapshot(): Rule[];
    restore(rules: Rule[]): void;
}
export declare class MemoryDecisionLedger implements DecisionLedger {
    private records;
    private seq;
    record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number;
    get(id: number): DecisionRecord | null;
    setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void;
    listPending(domain?: string, limit?: number): DecisionRecord[];
    listRecent(domain: string, limit: number): DecisionRecord[];
}
//# sourceMappingURL=store-memory.d.ts.map