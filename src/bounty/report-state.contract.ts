/** @implements SPEC-BOUNTY-INTAKE */
/**
 * C-1: the transition table of spec/feature/bug-bounty.md §9, spelled out here rather than
 * imported so the predicate states the spec instead of echoing the implementation it checks.
 * `deployed` is only reachable with deployment evidence (CC-BOUNTY-INV-09).
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  received: ["needs_info", "rejected", "duplicate", "accepted", "withdrawn"],
  needs_info: ["received", "rejected", "duplicate", "accepted", "withdrawn"],
  rejected: ["accepted"],
  duplicate: ["accepted", "rejected"],
  accepted: ["fix_pending", "rejected", "duplicate"],
  fix_pending: ["fixing", "fix_submitted", "deployed", "rejected", "duplicate"],
  fixing: ["fix_pending", "fix_submitted", "deployed", "rejected", "duplicate"],
  fix_submitted: ["fix_pending", "deployed", "rejected", "duplicate"],
  deployed: [],
  withdrawn: [],
};

function hasEvidence(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const value = evidence as { kind?: unknown; code?: unknown; hash?: unknown; reason?: unknown; actor?: unknown };
  const filled = (text: unknown): boolean => typeof text === "string" && text.trim().length > 0;
  if (value.kind === "deploy") return filled(value.code) && filled(value.hash);
  if (value.kind === "manual") return filled(value.reason) && filled(value.actor);
  return false;
}

export default {
  post(result: unknown, input: { from?: unknown; to?: unknown; deploymentEvidence?: unknown } | undefined): boolean {
    if (!result || typeof result !== "object") return false;
    const ok = (result as { ok?: unknown }).ok === true;
    const from = String(input?.from ?? "");
    const to = String(input?.to ?? "");
    const inTable = (ALLOWED[from] ?? []).includes(to);
    const evidenced = to !== "deployed" || hasEvidence(input?.deploymentEvidence);
    return ok === (inTable && evidenced);
  },
};
