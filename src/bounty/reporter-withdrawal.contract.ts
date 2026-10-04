/** @implements SPEC-BOUNTY-REPORTER */
/**
 * C-6: only the reporter may withdraw, and only before acceptance
 * (received / needs_info, spec/feature/bug-bounty.md §9).
 */
type Identity = { kind?: unknown; reporterId?: unknown; sessionId?: unknown };

function sameIdentity(left: Identity | undefined, right: Identity | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "person") return typeof left.reporterId === "string" && left.reporterId === right.reporterId;
  if (left.kind === "session") return typeof left.sessionId === "string" && left.sessionId === right.sessionId;
  return false;
}

export default {
  post(result: unknown, input: { status?: unknown; reporter?: Identity; actor?: Identity } | undefined): boolean {
    if (!result || typeof result !== "object") return false;
    const allowed = sameIdentity(input?.reporter, input?.actor)
      && (input?.status === "received" || input?.status === "needs_info");
    return ((result as { ok?: unknown }).ok === true) === allowed;
  },
};
