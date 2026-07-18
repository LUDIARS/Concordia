/** sessions.metadata に保存されたsession process PIDの安全な読み取り。 */

export function parseLictorPid(metadata: string | null): number | null {
  return parseMetaPid(metadata, "lictor_pid");
}

export function parseAgentClientPid(metadata: string | null): number | null {
  return parseMetaPid(metadata, "agent_client_pid");
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
