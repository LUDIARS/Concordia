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

  it("ignores a message mapped to a session that is no longer active (継続レビュー指摘)", () => {
    // archive 待ちでチャンネルがまだ残っている終了済み session への投稿は、
    // session 状態を確認してから inject 扱いにしない限りルーティングしない。
    const routeWithStatus = (isSessionActive: (sessionId: string) => boolean) =>
      routeSlackChannelMessage({
        event: { type: "message", channel: "SESSION", user: "U1", ts: "1" },
        hubChannelId: "HUB",
        botUserId: "BOT",
        sessionForChannel: (channelId) => (channelId === "SESSION" ? "s1" : null),
        isSessionActive,
      });

    expect(routeWithStatus(() => false)).toEqual({ kind: "ignore", reason: "session_inactive" });
    expect(routeWithStatus(() => true)).toEqual({ kind: "session", sessionId: "s1", channelId: "SESSION" });
  });

  it("keeps routing as session when isSessionActive is not supplied (backward compatibility)", () => {
    expect(route({ type: "message", channel: "SESSION", user: "U1", ts: "1" }))
      .toEqual({ kind: "session", sessionId: "s1", channelId: "SESSION" });
  });
});
