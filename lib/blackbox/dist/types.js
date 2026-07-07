// 成長型ブラックボックス — ドメイン非依存の中核型。
//
// このパッケージはランタイム依存ゼロ (Node 組込みすら engine/condition では使わない)。
// 永続化 (RuleStore / DecisionLedger) と LLM (LlmFallback) は利用側が注入する。
// 由来: Memoria server/blackbox/ を共通ライブラリ化 + 学習ループ再設計 (DESIGN.md)。
export {};
//# sourceMappingURL=types.js.map