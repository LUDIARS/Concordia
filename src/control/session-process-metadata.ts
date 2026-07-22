/** sessions.metadata に保存されたsession process PIDの安全な読み取り。 */

export function parseLictorPid(metadata: string | null): number | null {
  return parseMetaPid(metadata, "lictor_pid");
}

export function parseAgentClientPid(metadata: string | null): number | null {
  return parseMetaPid(metadata, "agent_client_pid");
}

export interface SessionProcessIdentity {
  instanceId: string;
  generationStartedAtMs: number;
}

/**
 * A PID is never ownership proof by itself. Cc-spawned Lictor processes carry
 * a one-time concordia_spawn_id plus Lictor's start_iso; together they bind a
 * session row to one process generation.
 */
export function parseSessionProcessIdentity(metadata: string | null): SessionProcessIdentity | null {
  if (!metadata) return null;
  try {
    const value = JSON.parse(metadata) as Record<string, unknown>;
    const instanceId = typeof value.concordia_spawn_id === "string"
      ? value.concordia_spawn_id.trim()
      : "";
    const started = typeof value.start_iso === "string" ? Date.parse(value.start_iso) : Number.NaN;
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(instanceId) || !Number.isFinite(started)) return null;
    return { instanceId, generationStartedAtMs: started };
  } catch {
    return null;
  }
}

export function matchesObservedProcessGeneration(
  metadata: string | null,
  processAgeSec: number,
  nowSec: number,
  toleranceSec = 30,
): boolean {
  const identity = parseSessionProcessIdentity(metadata);
  if (!identity || !Number.isFinite(processAgeSec) || processAgeSec < 0) return false;
  const observedStartedAtMs = (nowSec - processAgeSec) * 1000;
  return Math.abs(observedStartedAtMs - identity.generationStartedAtMs) <= toleranceSec * 1000;
}

function parseMetaPid(metadata: string | null, key: string): number | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
