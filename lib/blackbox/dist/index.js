// @ludiars/blackbox — 成長型ブラックボックス 公開 API。
//
// engine/condition/lifecycle/fingerprint/stats はランタイム依存ゼロ。
// store-sqlite は better-sqlite3 / node:sqlite の両方が満たす構造型のみに依存。
// 設計の正本は DESIGN.md。
export * from './types.js';
export { evaluate, validateCondition, describeCondition } from './condition.js';
export { canonicalJson, ruleFingerprint, sameOutput } from './fingerprint.js';
export { DEFAULT_THRESHOLDS, isLive, shadowPatch, verdictPatch } from './lifecycle.js';
export { BlackBoxEngine } from './engine.js';
export { domainStats } from './stats.js';
export { MemoryRuleStore, MemoryDecisionLedger } from './store-memory.js';
export { SqliteRuleStore, SqliteDecisionLedger, ensureBlackboxSchema, } from './store-sqlite.js';
import { BlackBoxEngine } from './engine.js';
import { domainStats } from './stats.js';
import { MemoryDecisionLedger, MemoryRuleStore } from './store-memory.js';
import { SqliteDecisionLedger, SqliteRuleStore, ensureBlackboxSchema } from './store-sqlite.js';
function bundle(rules, ledger, opts) {
    const engine = new BlackBoxEngine(rules, ledger, opts);
    return {
        engine, rules, ledger,
        stats: (domain, window = 100) => domainStats(domain, ledger.listRecent(domain, window), rules.listByDomain(domain)),
    };
}
/** SQLite (better-sqlite3 / node:sqlite) で束ねた blackbox を 1 つ作る。 schema も保証する。 */
export function makeSqliteBlackBox(db, opts) {
    ensureBlackboxSchema(db);
    return bundle(new SqliteRuleStore(db, opts?.now), new SqliteDecisionLedger(db), opts);
}
/** インメモリで束ねた blackbox を 1 つ作る (テスト / ゲームランタイム)。 */
export function makeMemoryBlackBox(opts) {
    return bundle(new MemoryRuleStore(opts?.now), new MemoryDecisionLedger(), opts);
}
//# sourceMappingURL=index.js.map