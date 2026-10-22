import { describe, expect, it } from "vitest";
import type { SessionMessagePayload } from "../shared/session-message-types.js";
import { isRelayableCanonicalMessage, type CanonicalRelayOptions } from "./session-message-relay.js";

function message(overrides: Partial<SessionMessagePayload>): SessionMessagePayload {
  return {
    id: 1, session_id: "s1", ts: 1, edited_ts: null, author_type: "assistant", author_label: "AI",
    author_platform: null, content: "本文", embeds: null, components: null, attachments: null,
    reference_id: null, metadata: null, dedupe_key: null, ...overrides,
  };
}

const slack: CanonicalRelayOptions = { platform: "slack", relayedUserOrigins: ["web"], hideThinking: true };
const discord: CanonicalRelayOptions = { platform: "discord", relayedUserOrigins: ["web", "slack"], hideThinking: false };

describe("isRelayableCanonicalMessage", () => {
  it("relays assistant text and drops the platform's own ingress", () => {
    expect(isRelayableCanonicalMessage(message({}), slack)).toBe(true);
    expect(isRelayableCanonicalMessage(message({ author_type: "user", author_platform: "slack" }), slack)).toBe(false);
    expect(isRelayableCanonicalMessage(message({ author_type: "user", author_platform: "discord" }), discord)).toBe(false);
  });

  it("relays user input only from the origins the platform has not seen", () => {
    expect(isRelayableCanonicalMessage(message({ author_type: "user", author_platform: "web" }), slack)).toBe(true);
    expect(isRelayableCanonicalMessage(message({ author_type: "user", author_platform: "discord" }), slack)).toBe(false);
    expect(isRelayableCanonicalMessage(message({ author_type: "user", author_platform: "slack" }), discord)).toBe(true);
    expect(isRelayableCanonicalMessage(message({ author_type: "user", author_platform: null }), discord)).toBe(false);
  });

  it("drops questions, successful tools, hidden thinking and Cc's own injects", () => {
    expect(isRelayableCanonicalMessage(message({ author_type: "question" }), slack)).toBe(false);
    expect(isRelayableCanonicalMessage(message({ author_type: "permission" }), slack)).toBe(false);
    expect(isRelayableCanonicalMessage(message({ author_type: "tool" }), slack)).toBe(false);
    expect(isRelayableCanonicalMessage(message({ author_type: "tool", metadata: { is_error: true } }), slack)).toBe(true);
    expect(isRelayableCanonicalMessage(message({ author_type: "thinking" }), slack)).toBe(false);
    expect(isRelayableCanonicalMessage(message({ author_type: "thinking" }), discord)).toBe(true);
    expect(isRelayableCanonicalMessage(message({ author_type: "system", metadata: { inject_is_cc: true } }), slack)).toBe(false);
    expect(isRelayableCanonicalMessage(message({ author_type: "system", metadata: { inject_is_cc: true, injection: {} } }), slack)).toBe(true);
  });
});
