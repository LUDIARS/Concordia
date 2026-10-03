/** Application use case: fresh discovery -> policy -> owned CAS adoption. */
import { randomUUID } from "node:crypto";
import type { ModelRoleRepo } from "../db/model-role-repo.js";
import { decideRoleAdoption, dueRefreshDay, type ProviderModel } from "./role-policy.js";
export interface OfficialModelProviderPort {
  discover(signal: AbortSignal): Promise<{ models: ProviderModel[]; source: string; observedAt: string }>;
}
export async function refreshModelRoles(input: {
  repo: ModelRoleRepo; provider: OfficialModelProviderPort; now: () => number;
  owner: string; signal: AbortSignal; revision?: () => string;
}): Promise<string> {
  const day = dueRefreshDay(input.now());
  if (!day || !input.repo.claim(day, input.owner, input.now(), 120_000)) return "not_due_or_owned";
  try {
    const discovery = await input.provider.discover(input.signal);
    const observedMs = Date.parse(discovery.observedAt);
    if (!Number.isFinite(observedMs) || observedMs > input.now() || input.now() - observedMs > 120_000) throw new Error("discovery_not_fresh");
    if (discovery.models.length > 1000) throw new Error("candidate_limit");
    const reasons: string[] = [];
    for (const current of input.repo.list()) {
      if (input.signal.aborted || !input.repo.owns(day, input.owner, input.now())) throw new Error("refresh_ownership_lost");
      if (current.provider !== "codex") { reasons.push(`${current.provider}:unsupported_provider`); continue; }
      const decision = decideRoleAdoption({ current, candidates: discovery.models, source: discovery.source });
      reasons.push(`${current.role}:${decision.reason}`);
      if (!decision.model) continue;
      const next = { ...current, modelId: decision.model.modelId, capabilities: decision.model.capabilities,
        revision: (input.revision ?? randomUUID)(), observedAt: discovery.observedAt,
        expiresAt: new Date(observedMs + 48 * 60 * 60_000).toISOString(), source: discovery.source };
      if (!input.repo.adopt(current.revision, next, decision.reason, input.now())) reasons.push(`${current.role}:revision_conflict`);
    }
    const reason = reasons.join(";");
    input.repo.finish(day, input.owner, input.now(), reason, true);
    return reason;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "discovery_failed";
    // Shutdown may close the DB after abort; the expiring lease preserves recovery.
    if (!input.signal.aborted) input.repo.finish(day, input.owner, input.now(), reason, false);
    return reason;
  }
}
