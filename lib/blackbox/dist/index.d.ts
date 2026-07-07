export * from './types.js';
export { evaluate, validateCondition, describeCondition } from './condition.js';
export { canonicalJson, ruleFingerprint, sameOutput } from './fingerprint.js';
export { DEFAULT_THRESHOLDS, isLive, shadowPatch, verdictPatch, type Thresholds } from './lifecycle.js';
export { BlackBoxEngine, type EngineOptions } from './engine.js';
export { domainStats, type DomainStats } from './stats.js';
export { MemoryRuleStore, MemoryDecisionLedger } from './store-memory.js';
export { SqliteRuleStore, SqliteDecisionLedger, ensureBlackboxSchema, type SqliteLike, type SqliteStatement, } from './store-sqlite.js';
import { BlackBoxEngine, type EngineOptions } from './engine.js';
import { type DomainStats } from './stats.js';
import type { DecisionLedger, RuleStore } from './types.js';
import { type SqliteLike } from './store-sqlite.js';
export interface BlackBox {
    engine: BlackBoxEngine;
    rules: RuleStore;
    ledger: DecisionLedger;
    /** domain の卒業メトリクス (直近 window 件、既定 100)。 */
    stats(domain: string, window?: number): DomainStats;
}
/** SQLite (better-sqlite3 / node:sqlite) で束ねた blackbox を 1 つ作る。 schema も保証する。 */
export declare function makeSqliteBlackBox(db: SqliteLike, opts?: EngineOptions): BlackBox;
/** インメモリで束ねた blackbox を 1 つ作る (テスト / ゲームランタイム)。 */
export declare function makeMemoryBlackBox(opts?: EngineOptions): BlackBox;
//# sourceMappingURL=index.d.ts.map