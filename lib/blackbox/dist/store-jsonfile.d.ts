import type { DecisionLedger, DecisionRecord, Rule, RuleDraft, RulePatch, RuleStore } from './types.js';
import { type EngineOptions } from './engine.js';
import type { BlackBox } from './index.js';
interface FileState {
    rules: Rule[];
    decisions: DecisionRecord[];
    seq: number;
}
export interface JsonFileStoreOptions {
    /** ledger に保持する直近判断数 (肥大防止)。既定 1000。ルールは丸めない。 */
    maxDecisions?: number;
    /** 時刻源 (テスト用)。 */
    now?: () => string;
}
/** rules / decisions を 1 つの JSON に共載する共有ファイル。 */
export declare class BlackboxJsonFile {
    private readonly path;
    constructor(path: string);
    load(): FileState;
    save(state: FileState): void;
}
export declare class JsonFileRuleStore implements RuleStore {
    private readonly file;
    private readonly now;
    constructor(file: BlackboxJsonFile, opts?: JsonFileStoreOptions);
    listByDomain(domain: string): Rule[];
    findByFingerprint(domain: string, fingerprint: string): Rule | null;
    get(id: string): Rule | null;
    insert(draft: RuleDraft): Rule;
    update(id: string, patch: RulePatch): Rule | null;
}
export declare class JsonFileDecisionLedger implements DecisionLedger {
    private readonly file;
    private readonly maxDecisions;
    constructor(file: BlackboxJsonFile, opts?: JsonFileStoreOptions);
    record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number;
    get(id: number): DecisionRecord | null;
    setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void;
    listPending(domain?: string, limit?: number): DecisionRecord[];
    listRecent(domain: string, limit: number): DecisionRecord[];
}
/** JSON ファイルで束ねた blackbox を 1 つ作る (CLI / ゲームサーバ向け)。 */
export declare function makeFileBlackBox(path: string, opts?: EngineOptions & JsonFileStoreOptions): BlackBox;
export {};
//# sourceMappingURL=store-jsonfile.d.ts.map