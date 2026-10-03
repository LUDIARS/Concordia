/** Pure adoption policy. @implements CC-SIDECAR-LIFECYCLE-MODELS SC-MODEL-01/02/04/05 */
export interface ModelCapabilities {
  reasoningEfforts: string[];
  inputModalities: string[];
  contextWindow?: number;
}
export interface RoleSnapshot {
  schemaVersion: 1;
  provider: string;
  role: string;
  modelId: string;
  revision: string;
  observedAt: string;
  expiresAt: string;
  capabilities: ModelCapabilities;
  source: string;
  pinned: boolean;
}
export interface ModelCatalogPort {
  resolve(input: { provider: string; role: string; context?: string }): Promise<RoleSnapshot>;
}
export interface ProviderModel {
  modelId: string;
  hidden: boolean;
  capabilities: ModelCapabilities;
  upgrade: string | null;
}
export const INITIAL_ROLE_MODELS = { sol: "gpt-6.1-sol", astra: "gpt-6-astra", luna: "gpt-6-luna" } as const;
export function initialRoleModel(role: string): string {
  const model = INITIAL_ROLE_MODELS[role as keyof typeof INITIAL_ROLE_MODELS];
  if (!model) throw new Error(`unsupported model role: ${role}`);
  return model;
}
export function decideRoleAdoption(input: {
  current: RoleSnapshot;
  candidates: readonly ProviderModel[];
  source: string;
}): { model: ProviderModel | null; reason: string } {
  if (input.current.pinned) return { model: null, reason: "manual_pin" };
  if (!input.source.startsWith("codex:model/list")) return { model: null, reason: "unsupported_official_source" };
  const current = input.candidates.find((m) => m.modelId === input.current.modelId);
  // The official listing is authoritative evidence; only strict numeric versions
  // in this same role/family are comparable. Unknown formats never become latest.
  const stable = input.candidates.filter((m) => !m.hidden && m.capabilities.reasoningEfforts.includes("medium")
    && (input.current.role !== "sol" || m.capabilities.reasoningEfforts.includes("xhigh"))
    && m.capabilities.inputModalities.includes("text") && numericRoleVersion(m.modelId,input.current.role));
  let latestId = input.current.modelId;
  let latestVersion = numericRoleVersion(latestId,input.current.role);
  for (const candidate of stable) {
    const version = numericRoleVersion(candidate.modelId,input.current.role)!;
    if (latestVersion && (version[0] > latestVersion[0] || (version[0] === latestVersion[0] && version[1] > latestVersion[1]))) {
      latestId = candidate.modelId; latestVersion = version;
    }
  }
  const targetId = current?.upgrade ?? latestId;
  const target = input.candidates.find((m) => m.modelId === targetId);
  if (!target) return { model: null, reason: "model_not_available" };
  const targetVersion = numericRoleVersion(targetId,input.current.role);
  const currentVersion = numericRoleVersion(input.current.modelId,input.current.role);
  if (!targetVersion || !currentVersion) return { model:null,reason:"unknown_version_format" };
  if (targetVersion[0] < currentVersion[0] || (targetVersion[0] === currentVersion[0] && targetVersion[1] < currentVersion[1])) return { model:null,reason:"automatic_downgrade_rejected" };
  if (target.hidden || /preview|experimental|beta/i.test(target.modelId)
    || !new RegExp(`^gpt-\\d+(?:\\.\\d+)?-${input.current.role}$`).test(target.modelId)) {
    return { model: null, reason: "unstable_or_different_family" };
  }
  if (!target.capabilities.reasoningEfforts.includes("medium")
    || (input.current.role === "sol" && !target.capabilities.reasoningEfforts.includes("xhigh"))
    || !target.capabilities.inputModalities.includes("text")) return { model: null, reason: "capability_mismatch" };
  return { model: target, reason: targetId === input.current.modelId ? "verified_current" : current?.upgrade ? "provider_upgrade" : "official_numeric_latest" };
}
export function numericRoleVersion(modelId: string, role: string): [number,number] | null {
  if (!["sol","astra","luna"].includes(role)) return null;
  const match = new RegExp(`^gpt-(\\d+)(?:\\.(\\d+))?-${role}$`).exec(modelId);
  return match ? [Number(match[1]),Number(match[2] ?? 0)] : null;
}
export function resolveRoleSnapshot(snapshot: RoleSnapshot | null, nowMs: number, context?: string): RoleSnapshot {
  if (!snapshot) throw new Error("model_role_unavailable");
  if (snapshot.schemaVersion !== 1 || !Number.isFinite(Date.parse(snapshot.observedAt))
    || !Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt) <= nowMs
    || Date.parse(snapshot.observedAt) > nowMs || Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.observedAt)
    || Date.parse(snapshot.expiresAt)-Date.parse(snapshot.observedAt) > 48 * 60 * 60_000) {
    throw new Error("model_snapshot_expired_or_invalid");
  }
  if (context && context !== "default") throw new Error("model_context_unsupported");
  return snapshot;
}
export function dueRefreshDay(nowMs: number): string | null {
  const jst = new Date(nowMs + 9 * 60 * 60_000);
  if (jst.getUTCHours() < 10) return null;
  return jst.toISOString().slice(0, 10);
}
