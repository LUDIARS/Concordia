import { createChildLogger } from "../shared/logger.js";
import { injectSession } from "../platform/session-inject.js";
import { buildSlackConsultationBody } from "./ingress-chat.js";

const log = createChildLogger("slack/router");

export interface SlackIngressDeps {
  concordiaUrl: string;
  readModel: { isCodexSession(sessionId: string): boolean };
}

export async function injectToSession(
  deps: SlackIngressDeps,
  sessionId: string,
  text: string,
  source: string,
  authorLabel?: string,
): Promise<void> {
  const result = await injectSession({
    concordiaUrl: deps.concordiaUrl,
    sessionId,
    text,
    source,
    authorLabel,
    enterFallbackSource: deps.readModel.isCodexSession(sessionId) ? "slack-enter-fallback" : undefined,
  });
  if (result.ok) log.info(`ingress inject ok session=${sessionId}`);
  else if (result.kind === "http") log.warn(`ingress inject failed status=${result.status} session=${sessionId}`);
  else log.warn(`ingress inject network error session=${sessionId}: ${result.message}`);
}

export async function postChat(
  deps: Pick<SlackIngressDeps, "concordiaUrl">,
  text: string,
  userId: string,
  sessionId: string | null,
): Promise<void> {
  try {
    const response = await fetch(`${deps.concordiaUrl}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildSlackConsultationBody(text, userId, sessionId)),
    });
    if (!response.ok) log.warn(`ingress /v1/chat returned ${response.status}`);
  } catch (error) {
    log.warn(`ingress /v1/chat failed: ${(error as Error).message}`);
  }
}
