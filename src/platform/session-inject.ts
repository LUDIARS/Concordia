import { ENTER_KEY_TEXT } from "./enter-key.js";

export type SessionInjectResult =
  | { ok: true }
  | { ok: false; kind: "http"; status: number }
  | { ok: false; kind: "network"; message: string };

export interface SessionInjectInput {
  concordiaUrl: string;
  sessionId: string;
  text: string;
  source: string;
  authorLabel?: string;
  enterFallbackSource?: string;
  fetchImpl?: typeof fetch;
}

export async function injectSession(input: SessionInjectInput): Promise<SessionInjectResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${input.concordiaUrl.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(input.sessionId)}/inject`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: input.text.slice(0, 4000),
        source: input.source,
        ...(input.authorLabel ? { author_label: input.authorLabel } : {}),
      }),
    });
    if (!response.ok) return { ok: false, kind: "http", status: response.status };

    if (input.enterFallbackSource) {
      try {
        await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: ENTER_KEY_TEXT, source: input.enterFallbackSource }),
        });
      } catch {
        // Main inject already succeeded; Enter fallback is intentionally best-effort.
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
