import { describe, expect, it } from "vitest";
import { routeSlackChannelMessage } from "./session-channel-routing.js";

const route = (event: Parameters<typeof routeSlackChannelMessage>[0]["event"]) =>
  routeSlackChannelMessage({
    event,
    hubChannelId: "HUB",
    botUserId: "BOT",
    sessionForChannel: (channelId) => channelId === "SESSION" ? "s1" : null,
  });

describe("routeSlackChannelMessage", () => {
  it("routes top-level Hub and mapped session messages", () => {
    expect(route({ type: "message", channel: "SESSION", user: "U1", ts: "1" }))
      .toEqual({ kind: "session", sessionId: "s1", channelId: "SESSION" });
    expect(route({ type: "message", channel: "HUB", user: "U1", ts: "2" }))
      .toEqual({ kind: "hub", channelId: "HUB" });
  });

  it("ignores thread replies, bot/system messages, and unknown channels", () => {
    expect(route({ type: "message", channel: "SESSION", user: "U1", ts: "2", thread_ts: "1" }))
      .toEqual({ kind: "ignore", reason: "thread_reply" });
    expect(route({ type: "message", channel: "SESSION", user: "BOT", ts: "1" }).kind).toBe("ignore");
    expect(route({ type: "message", channel: "OTHER", user: "U1", ts: "1" }))
      .toEqual({ kind: "ignore", reason: "unknown_channel" });
  });
});
