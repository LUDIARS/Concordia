// 卒業メトリクス。 純粋関数のみ。
//
// 「LLM をどれだけ卒業できたか」 = 直近判断のうちルールで即決できた割合 (ruleCoverage)。
// ドメインごとに出し、 UI / 通知で成長を可視化する。

import type { DecisionRecord, Rule, RuleState } from './types.js';

export interface DomainStats {
  domain: string;
  /** 集計対象にした直近判断数。 */
  window: number;
  ruleDecisions: number;
  llmDecisions: number;
  /** ルール由来の割合 0..1。 1.0 = 完全卒業。 判断が無ければ 0。 */
  ruleCoverage: number;
  /** verdict 待ちの判断数 (レビューキューの深さ)。 */
  pendingReview: number;
  ruleStates: Record<RuleState, number>;
}

export function domainStats(domain: string, recent: DecisionRecord[], rules: Rule[]): DomainStats {
  const ruleDecisions = recent.filter((d) => d.source === 'rule').length;
  const llmDecisions = recent.filter((d) => d.source === 'llm').length;
  const pendingReview = recent.filter((d) => d.status === 'pending_review' && d.verdict === null).length;
  const ruleStates: Record<RuleState, number> = { candidate: 0, trial: 0, auto: 0, retired: 0 };
  for (const r of rules) ruleStates[r.state] += 1;
  return {
    domain,
    window: recent.length,
    ruleDecisions,
    llmDecisions,
    ruleCoverage: recent.length === 0 ? 0 : ruleDecisions / recent.length,
    pendingReview,
    ruleStates,
  };
}
