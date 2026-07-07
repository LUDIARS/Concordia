// 卒業メトリクス。 純粋関数のみ。
//
// 「LLM をどれだけ卒業できたか」 = 直近判断のうちルールで即決できた割合 (ruleCoverage)。
// ドメインごとに出し、 UI / 通知で成長を可視化する。
export function domainStats(domain, recent, rules) {
    const ruleDecisions = recent.filter((d) => d.source === 'rule').length;
    const llmDecisions = recent.filter((d) => d.source === 'llm').length;
    const pendingReview = recent.filter((d) => d.status === 'pending_review' && d.verdict === null).length;
    const ruleStates = { candidate: 0, trial: 0, auto: 0, retired: 0 };
    for (const r of rules)
        ruleStates[r.state] += 1;
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
//# sourceMappingURL=stats.js.map