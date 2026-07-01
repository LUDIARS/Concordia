import { describe, expect, it } from "vitest";
import { isActiveRelayTarget, isChatRelayTarget, trustedDiscordChannelId } from "./egress.js";

describe("trustedDiscordChannelId", () => {
  it("accepts the explicit channel when it matches the session channel", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "c1",
      sessionId: "s1",
      sessionChannelId: "c1",
      forceMeta: false,
    })).toBe("c1");
  });

  it("rejects a mismatched explicit channel for session-scoped posts", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "c2",
      sessionId: "s1",
      sessionChannelId: "c1",
      forceMeta: false,
    })).toBeNull();
  });

  it("keeps explicit routing for meta-channel posts", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "meta1",
      sessionId: "s1",
      sessionChannelId: "c1",
      forceMeta: true,
    })).toBe("meta1");
  });

  it("rejects explicit routing when the chat has no session", () => {
    expect(trustedDiscordChannelId({
      explicitChannelId: "meta1",
      sessionId: null,
      sessionChannelId: null,
      forceMeta: true,
    })).toBeNull();
  });
});

describe("isActiveRelayTarget", () => {
  it("allows relay only when both Concordia session and Discord channel mapping are active", () => {
    expect(isActiveRelayTarget("active", "active")).toBe(true);
    expect(isActiveRelayTarget("lost", "active")).toBe(false);
    expect(isActiveRelayTarget("active", "lost")).toBe(false);
    expect(isActiveRelayTarget("ended", "active")).toBe(false);
    expect(isActiveRelayTarget("active", null)).toBe(false);
  });
});

describe("isChatRelayTarget", () => {
  it("requires both a session id and an active Discord session channel", () => {
    expect(isChatRelayTarget("s1", "active", "active")).toBe(true);
    expect(isChatRelayTarget(null, null, null)).toBe(false);
    expect(isChatRelayTarget("s1", "active", null)).toBe(false);
    expect(isChatRelayTarget("s1", "ended", "active")).toBe(false);
  });
});
