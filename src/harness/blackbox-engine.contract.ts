/** @implements spec/domains/blackbox-decision.domain.json — learned rule outputs must not replay stale gate reasons */
/**
 * harness-stale-reason-C-1: the rule may choose the decision, but every hit the current
 * deterministic verdict produced is returned with its current text, and the current reason
 * is carried into the returned reason.
 */
interface Hit { rule?: unknown; reason?: unknown }
interface Verdict { decision?: unknown; hits?: unknown; reason?: unknown; blocked?: unknown }

function hitsOf(v: Verdict | null | undefined): Hit[] {
  return v && Array.isArray(v.hits) ? (v.hits as Hit[]) : [];
}

export default {
  post(result: unknown, ruleOutput: unknown, current: Verdict): boolean {
    const r = result as Verdict | null;
    if (!r || typeof r.reason !== "string" || !current) return false;
    const out = ruleOutput as Verdict | null;
    const ruleDecision = out && (out.decision === "deny" || out.decision === "warn" || out.decision === "allow")
      ? out.decision
      : current.decision;
    if (r.decision !== ruleDecision || r.blocked !== (ruleDecision === "deny")) return false;
    const returned = hitsOf(r);
    for (const hit of hitsOf(current)) {
      const same = returned.find((h) => h.rule === hit.rule);
      if (!same || same.reason !== hit.reason) return false;
    }
    if (hitsOf(current).length > 0 && typeof current.reason === "string" && !r.reason.includes(current.reason)) {
      return false;
    }
    return true;
  },
};
