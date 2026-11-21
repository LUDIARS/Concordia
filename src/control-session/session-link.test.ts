import { describe, expect, it, vi } from "vitest";
import type { ControlBoardRow } from "./board-repo.js";
import { controlSessionLink, safeLinkResolver, withSessionLinks, type ControlSessionLinkDeps } from "./session-link.js";

const HQ = "100000000000000001";
const SUB = "100000000000000002";
const CHANNEL = "200000000000000001";
const CARD_CHANNEL = "200000000000000002";
const MESSAGE = "300000000000000001";

function deps(patch: Partial<ControlSessionLinkDeps> = {}): ControlSessionLinkDeps {
  return {
    latestUnansweredQuestion: () => null,
    sessionChannel: () => ({ channel_id: CHANNEL, scope: "" }),
    hqGuildId: () => HQ,
    subsidiaryGuildId: (id) => (id === "acme" ? SUB : null),
    ...patch,
  };
}

describe("control session link (spec/feature/control-session.md §10)", () => {
  it("prefers the unanswered question card's message URL", () => {
    const link = controlSessionLink(deps({
      latestUnansweredQuestion: (id) => ({ session_id: id, discord_message_id: MESSAGE, discord_channel_id: CARD_CHANNEL }),
    }), "s1");
    expect(link).toBe(`https://discord.com/channels/${HQ}/${CARD_CHANNEL}/${MESSAGE}`);
  });

  it("falls back to the session channel when there is no card or the card has no message position", () => {
    expect(controlSessionLink(deps(), "s1")).toBe(`https://discord.com/channels/${HQ}/${CHANNEL}`);
    expect(controlSessionLink(deps({
      latestUnansweredQuestion: (id) => ({ session_id: id, discord_message_id: null, discord_channel_id: null }),
    }), "s1")).toBe(`https://discord.com/channels/${HQ}/${CHANNEL}`);
  });

  it("uses the subsidiary guild for sub: scopes", () => {
    expect(controlSessionLink(deps({ sessionChannel: () => ({ channel_id: CHANNEL, scope: "sub:acme" }) }), "s1"))
      .toBe(`https://discord.com/channels/${SUB}/${CHANNEL}`);
    expect(controlSessionLink(deps({ sessionChannel: () => ({ channel_id: CHANNEL, scope: "sub:unknown" }) }), "s1")).toBeNull();
  });

  it("returns null without a channel row or when ids are not snowflakes", () => {
    expect(controlSessionLink(deps({ sessionChannel: () => null }), "s1")).toBeNull();
    expect(controlSessionLink(deps({ hqGuildId: () => null }), "s1")).toBeNull();
    expect(controlSessionLink(deps({ sessionChannel: () => ({ channel_id: "slack-C123", scope: "" }) }), "s1")).toBeNull();
  });

  it("turns resolver errors into no link with a warning and defaults to no link", () => {
    const warn = vi.fn();
    const resolve = safeLinkResolver(() => { throw new Error("db closed"); }, { warn });
    expect(resolve("s1")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("s1"));
    expect(safeLinkResolver(undefined, { warn })("s1")).toBeNull();
  });

  it("adds the link to each board row", () => {
    const rows = [{ session_id: "a" }, { session_id: "b" }] as ControlBoardRow[];
    expect(withSessionLinks(rows, (id) => (id === "a" ? "https://discord.com/channels/1/2" : null)).map((row) => row.link))
      .toEqual(["https://discord.com/channels/1/2", null]);
  });
});
