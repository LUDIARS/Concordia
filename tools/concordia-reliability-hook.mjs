import { createHash, randomUUID } from "node:crypto";

/** Provider envelopes only. Tool content never supplies a trusted source identity. */
export function reliabilityPayload(event, ctx) {
  const response = ctx?.tool_response ?? ctx?.tool_result ?? ctx?.error ?? null;
  const message = typeof response === "string" ? response : JSON.stringify(response ?? "");
  const tool = ctx?.tool_name ?? "";
  const stable = ctx?.tool_use_id ?? ctx?.turn_id;
  const eventId = stable ? `${event}:${stable}` : `${event}:${randomUUID()}`;
  if (event === "compact") return { event: "pre-compact", event_id: eventId, trigger: ctx?.trigger ?? "unknown" };
  if (event === "post-compact") return { event: "post-compact", event_id: eventId, trigger: ctx?.trigger ?? "unknown" };
  if (event === "resume-compact") return { event: "resume-compact", event_id: eventId, trigger: ctx?.source ?? "compact" };
  if (event === "prompt") return { event: "prompt", event_id: eventId, prompt: String(ctx?.prompt ?? ctx?.user_prompt ?? "").slice(0, 16000) };
  if (event === "tool-result" || event === "tool-failure") {
    const status = response?.status ?? response?.statusCode ?? response?.error?.status;
    return { event: "tool-result", event_id: eventId, tool,
      failed: event === "tool-failure" || response?.isError === true || response?.is_error === true || ctx?.is_error === true || !!response?.error || (typeof response?.exit_code === "number" && response.exit_code !== 0),
      ...(Number.isInteger(status) ? { status } : {}),
      ...(typeof response?.code === "string" ? { code: response.code.slice(0, 256) } : {}),
      message: message.slice(0, 16000) };
  }
  return null;
}

export async function observeReliability({ event, ctx, sessionId, post }) {
  const payload = reliabilityPayload(event, ctx);
  if (!payload || !sessionId) return null;
  // Hash is useful for transport deduplication; it confers no trust.
  if (event === "prompt") payload.event_id = `prompt:${createHash("sha256").update(payload.prompt).digest("hex")}`;
  const result = await post(`/v1/harness/reliability/${encodeURIComponent(sessionId)}/hook`, payload);
  if (!result?.ok) process.stderr.write(`[concordia-hook] ${event}: checkpoint/observation not confirmed; inspect Cc before relying on recovery.\n`);
  return result;
}
