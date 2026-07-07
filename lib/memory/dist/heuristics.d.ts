/**
 * メモリ/スキル中身の poison heuristics (純粋)。
 *
 * `src/skills/analyzer.ts` の DANGER_PATTERNS と同系統。 こちらは library 向けに
 * 危険コマンド + prompt-injection に絞った検出。 ヒットした理由文字列を返す
 * (重み付けはせず「人間レビューを促すフラグ」として扱う)。
 */
/** 中身を走査し、 当たった危険理由の配列を返す (無ければ空)。 */
export declare function scanPoison(content: string): string[];
