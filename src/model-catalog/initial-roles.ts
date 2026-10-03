import type { ModelRoleRepo } from "../db/model-role-repo.js";
import { INITIAL_ROLE_MODELS } from "./role-policy.js";
/** Configured bootstrap data, explicitly distinct from a fresh provider query. */
export function seedInitialRoles(repo: ModelRoleRepo, nowMs = Date.now()): void {
  for (const [role, modelId] of Object.entries(INITIAL_ROLE_MODELS)) repo.seed({ schemaVersion: 1,
    provider: "codex", role, modelId, revision: `initial-20261003-${role}`,
    observedAt:new Date(nowMs).toISOString(),expiresAt:new Date(nowMs+24*60*60_000).toISOString(),
    source: "configured-bootstrap:2026-10-03:codex-catalog", pinned: false,
    capabilities: { reasoningEfforts: ["medium", "high", "xhigh"], inputModalities: ["text", "image"] } });
}
