import type { DecisionLedger, DecisionRecord, Rule, RuleDraft, RulePatch, RuleStore } from './types.js';
/** better-sqlite3 Database / node:sqlite DatabaseSync が構造的に満たす最小面。 */
export interface SqliteStatement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): {
        lastInsertRowid: number | bigint;
    };
}
export interface SqliteLike {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): void;
}
/**
 * テーブルを作成し、 旧 schema (Memoria v1) なら列を足して state を埋める。
 * 旧 enabled 列は残すが以後は参照しない。 何度呼んでも冪等。
 */
export declare function ensureBlackboxSchema(db: SqliteLike): void;
export declare class SqliteRuleStore implements RuleStore {
    private readonly db;
    private readonly now;
    constructor(db: SqliteLike, now?: () => string);
    listByDomain(domain: string): Rule[];
    findByFingerprint(domain: string, fingerprint: string): Rule | null;
    get(id: string): Rule | null;
    insert(draft: RuleDraft): Rule;
    update(id: string, patch: RulePatch): Rule | null;
}
export declare class SqliteDecisionLedger implements DecisionLedger {
    private readonly db;
    constructor(db: SqliteLike);
    record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number;
    get(id: number): DecisionRecord | null;
    setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void;
    listPending(domain?: string, limit?: number): DecisionRecord[];
    listRecent(domain: string, limit: number): DecisionRecord[];
}
//# sourceMappingURL=store-sqlite.d.ts.map