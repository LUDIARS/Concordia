/** 値を キー昇順・配列順保持 で決定的に直列化する。 */
export declare function canonicalJson(value: unknown): string;
/** ルールの論理内容の指紋。 同 domain 内の重複提案マージ・撤回後の再提案ブロックに使う。 */
export declare function ruleFingerprint(when: unknown, output: unknown): string;
/** output 同士の同値判定 (影評価の一致/不一致)。 */
export declare function sameOutput(a: unknown, b: unknown): boolean;
//# sourceMappingURL=fingerprint.d.ts.map