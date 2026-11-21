import { basename } from "node:path";
import { fetchFromLictor, resolveLictorTarget } from "../../control/lictor-proxy.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import { AGY_USAGE_BINDINGS, agyBindingsForSession, rememberAgyBinding, trustedAgyPath } from "../../cost/agy-usage-binding.js";
import type { SessionRow } from "../../shared/types.js";

const TIMEOUT_MS = 750;
const HEADER_LIMIT = 4096;
const availableHeader = Buffer.from(',"available":true,');

/** Lictor serializes the binding before its frames. Consume the path only. */
async function readBoundPath(response: Response): Promise<string | null> {
  if (!response.body) return null;
  if (!response.ok) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  let header = Buffer.alloc(0);
  try {
    while (header.length < HEADER_LIMIT) {
      const { value, done } = await reader.read();
      if (done) return null;
      header = Buffer.concat([header, value.subarray(0, HEADER_LIMIT - header.length)]);
      const end = header.indexOf(availableHeader);
      if (end === -1) continue;
      const prefix = header.subarray(0, end).toString("utf8");
      const data = JSON.parse(prefix + "}") as { path?: unknown };
      return typeof data.path === "string" ? data.path : null;
    }
    return null;
  } finally {
    await reader.cancel().catch(() => { /* The sidecar may have already disconnected. */ });
    reader.releaseLock();
  }
}

/** Store only a Lictor-proven launch identity, never infer it from a shared cwd or mtime. */
export async function captureAgyUsageBinding(
  repo: SessionsRepo,
  session: SessionRow,
  request = fetchFromLictor,
  resolvePath = trustedAgyPath,
): Promise<void> {
  const target = resolveLictorTarget(repo, session.id);
  if ("error" in target || !Number.isInteger(target.port) || target.port <= 0 || target.port > 65535) return;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const metaResponse = await request(target.port, "/v1/meta", { signal, redirect: "error" });
  if (!metaResponse.ok) {
    await metaResponse.body?.cancel();
    return;
  }
  const meta = await metaResponse.json() as { session_id?: string; provider?: string; start_iso?: string; hostname?: string; cwd?: string };
  if (meta.session_id !== session.id || meta.provider !== "agy" || meta.hostname !== session.host || !meta.cwd) return;
  const startedAtMs = Date.parse(meta.start_iso ?? "");
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0 || startedAtMs >= (session.started_at + 1) * 1000) return;
  const path = await readBoundPath(await request(target.port, "/v1/transcript?limit=1", { signal, redirect: "error" }));
  const trusted = path ? await resolvePath(path) : null;
  if (!trusted) return;
  const current = repo.findSession(session.id);
  if (current?.provider !== "antigravity-cli" || current.started_at !== session.started_at) return;
  const binding = { id: basename(trusted, ".db").toLowerCase(), startedAtMs };
  if (agyBindingsForSession(current).some(({ id }) => id === binding.id)) return;
  repo.updateMetadata(session.id, (data) => ({
    ...data,
    [AGY_USAGE_BINDINGS]: rememberAgyBinding(data[AGY_USAGE_BINDINGS], binding),
  }));
}
