/** @implements spec/feature/project-harness-policy.md */
import type { HarnessAction, Predicate } from "./predicates.js";
import { isEditTool } from "./predicates.js";

export interface ProjectHarnessPolicy { ddd: boolean; contract: boolean; testsRequired?: boolean; ontimeTestsRequired?: boolean }

/**
 * `contract_enabled` は「契約の確定・承認を **追加で** 要求するか」の opt-in であって、
 * 既存の安全境界を外す opt-out ではない。 未選択プロジェクト (既定 0) でも、 セッション契約が
 * 実際に vibes/plan を宣言していれば従来どおり vibesScope / vibesFileLimit / planUnapproved が
 * 効く必要がある — vibesScope は migration・schema・auth・破壊的パスへの編集を止める唯一の
 * 述語なので、 これを既定で外すと全プロジェクトで保護が消える。
 *
 * したがって述語セットは opt-in 状態によらず常に完全なまま返す。 追加要件の強制は
 * gate ハンドラ側で `contractComplete` を fail-closed にするかどうかで表現する
 * (spec/feature/project-harness-policy.md: 「未選択プロジェクトへこれらの追加要件を
 * 強制しない。 既存の安全規則を解除する設定ではない」)。
 */
export function projectPredicates(predicates: readonly Predicate[], _policy?: ProjectHarnessPolicy): Predicate[] {
  return [...predicates];
}

export function needsDddEvidence(action: HarnessAction, policy?: ProjectHarnessPolicy): boolean {
  return policy?.ddd === true && isEditTool(action.tool) && !!action.filePath
    && !/(?:^|[\\/])spec[\\/]|(?:^|[\\/])AGENTS\.md$/i.test(action.filePath);
}

export const DDD_INSTRUCTION = "DDD適用プロジェクトです。spec/uxの価値・シナリオ、spec/domainsの所属、状態所有者と不変条件を定義してからコードを編集してください。設計判断の根拠をspecに残してください。";
