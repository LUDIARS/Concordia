import { describe, expect, it, vi } from "vitest";
import { resolveSessionSourceLinks } from "./session-source-links.js";

describe("resolveSessionSourceLinks", () => {
  it("returns the Discord starter and Slack header permalinks for the session", async () => {
    const resolveSlackPermalink = vi.fn(async () => "https://workspace.slack.com/archives/C2/p123400");
    const links = await resolveSessionSourceLinks({
      discordChannels: {
        findBySessionId: () => ({ channel_id: "D1", surface_message_id: "M1" } as never),
      },
      slackChannels: {
        findBySessionId: () => ({ channel_id: "C2", header_ts: "1234.00" } as never),
      },
      resolveDiscordGuildId: () => "G1",
      resolveSlackBotToken: () => "xoxb-secret",
      resolveSlackPermalink,
      log: { warn: vi.fn() },
    }, "session-1");

    expect(links).toEqual([
      {
        platform: "discord",
        label: "Discord セッション投稿",
        url: "https://discord.com/channels/G1/D1/M1",
      },
      {
        platform: "slack",
        label: "Slack セッション投稿",
        url: "https://workspace.slack.com/archives/C2/p123400",
      },
    ]);
    expect(resolveSlackPermalink).toHaveBeenCalledWith("xoxb-secret", "C2", "1234.00");
  });

  it("does not persist a non-Slack permalink returned by the integration", async () => {
    const links = await resolveSessionSourceLinks({
      discordChannels: { findBySessionId: () => null },
      slackChannels: {
        findBySessionId: () => ({ channel_id: "C2", header_ts: "1234.00" }),
      },
      resolveDiscordGuildId: () => null,
      resolveSlackBotToken: () => "xoxb-secret",
      resolveSlackPermalink: async () => "https://example.invalid/redirect",
      log: { warn: vi.fn() },
    }, "session-1");

    expect(links).toEqual([]);
  });
});
