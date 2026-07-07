import type { Condition, FeatureMap } from './types.js';
/** Condition を features に対して評価する。 未知 feature や型不一致は false。 */
export declare function evaluate(cond: Condition, features: FeatureMap): boolean;
/**
 * 信頼できない入力 (LLM 生成 / API body) から来た Condition を検証する。
 * 不正なら理由を投げる。 深さは DoS 対策で 8 段まで。
 */
export declare function validateCondition(value: unknown, depth?: number): Condition;
/** Condition を人間可読な短文に整形する (UI / 通知のルール説明用)。 */
export declare function describeCondition(cond: Condition): string;
//# sourceMappingURL=condition.d.ts.map