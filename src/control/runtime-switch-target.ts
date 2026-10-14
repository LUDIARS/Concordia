/**
 * Sidecar target for the runtime model/effort switch (`/v1/runtime/model-effort`).
 *
 * Lictor publishes `lictor_port`. Satelles (codex-sdk) publishes
 * `satelles_sidecar_port` instead: its sidecar is a compatibility subset, and
 * `lictor_port` would make the Lictor-only operations (force-exit, PTY rename,
 * relictor) target it. Only this switch accepts the Satelles key, so
 * `resolveLictorTarget` keeps meaning "a Lictor process".
 *
 * @implements SPEC-RUNTIME-MODEL-EFFORT
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { resolveLictorTarget, type LictorTarget } from "./lictor-proxy.js";

export const SATELLES_SIDECAR_PORT_KEY = "satelles_sidecar_port";

export function resolveRuntimeSwitchTarget(
  repo: Pick<SessionsRepo, "findSession">,
  sessionId: string,
): LictorTarget | { error: string } {
  const lictor = resolveLictorTarget(repo as SessionsRepo, sessionId);
  if (!("error" in lictor)) return lictor;
  const row = repo.findSession(sessionId);
  if (!row || row.status !== "active" || !row.metadata) return lictor;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return lictor;
  }
  const port = meta[SATELLES_SIDECAR_PORT_KEY];
  if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) {
    return { sessionId, port };
  }
  return lictor;
}
