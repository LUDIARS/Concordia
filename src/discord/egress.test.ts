import { describe, expect, it } from "vitest";
import { trustedDiscordChannelId } from "./egress.js";

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
});
