import type { SessionInjectEmitter } from "../shared/injection-provenance.js";

interface RemoteInjectLog {
  warn(message: string): void;
}

/** Standalone chat worker から backend の session.inject へ転送する transport adapter。 */
export function createRemoteSessionInject(
  concordiaUrl: string,
  log: RemoteInjectLog,
  fetchImpl: typeof fetch = fetch,
): SessionInjectEmitter {
  return (sessionId, text, source, provenance) => {
    void fetchImpl(`${concordiaUrl}/v1/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, source, ...(provenance ? { provenance } : {}) }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((error) => log.warn(`remote inject failed session=${sessionId}: ${(error as Error).message}`));
  };
}
