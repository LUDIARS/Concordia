import { describe, expect, it, vi } from "vitest";
import { sendDiscordPublication } from "./discord-delivery.js";
import { sendSlackPublication } from "./slack-delivery.js";
import type { Publication } from "./model.js";

const article = { page_id: "3d839cbfbab98174bb4ef6787481efc9", title: "<!channel> <@USERID>",
  url: "https://app.notion.com/p/3d839cbfbab98174bb4ef6787481efc9" };
const base: Omit<Publication, "target"> = { article_id: article.page_id, target_key: "test", article, status: "sending",
  attempt_id: "one", receipt: null, error_code: null, resolution: null, updated_at: 1_000 };
const forum = { kind: "discord-forum" as const, guild_id: "111111111111111111", channel_id: "222222222222222222", applied_tags: ["555555555555555555"] };
const slack = { kind: "slack-channel" as const, team_id: "T12345678", channel_id: "C12345678" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AI note platform delivery", () => {
  it("does not post after losing the persisted send claim during preflight", async () => {
    const target = { kind: "discord-channel" as const, guild_id: forum.guild_id, channel_id: forum.channel_id };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: target.channel_id, guild_id: target.guild_id, type: 0 }));
    const result = await sendDiscordPublication({ config: () => ({ enabled: true, token: "test" }), fetcher }, { ...base, target }, () => false);
    expect(result).toEqual({ status: "failed", error_code: "delivery_claim_lost" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a different Discord guild before posting", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: forum.channel_id, guild_id: "666666666666666666", type: 15 }));
    const result = await sendDiscordPublication({ config: () => ({ enabled: true, token: "test-token" }), fetcher }, { ...base, target: forum }, () => true);
    expect(result).toEqual({ status: "failed", error_code: "discord_target_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  });

  it("creates a tagged forum post with mentions disabled and preserves the receipt", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: forum.channel_id, guild_id: forum.guild_id, type: 15, flags: 16, available_tags: [{ id: forum.applied_tags[0] }] }))
      .mockResolvedValueOnce(json({ id: "777777777777777777", parent_id: forum.channel_id,
        message: { id: "777777777777777777", channel_id: "777777777777777777", content: "notice", author: { id: "888888888888888888", bot: true } } }));
    const result = await sendDiscordPublication({ config: () => ({ enabled: true, token: "test-token" }), fetcher }, { ...base, target: forum }, () => true);
    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(body.applied_tags).toEqual(forum.applied_tags);
    expect(body.message.allowed_mentions.parse).toEqual([]);
    expect(body.message.content).toContain(article.url);
  });

  it.each([[403, "failed"], [500, "unknown"]] as const)("classifies HTTP %s without retry", async (status, expected) => {
    const target = { kind: "discord-channel" as const, guild_id: forum.guild_id, channel_id: forum.channel_id };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: target.channel_id, guild_id: target.guild_id, type: 0 }))
      .mockResolvedValueOnce(json({}, status));
    expect((await sendDiscordPublication({ config: () => ({ enabled: true, token: "test" }), fetcher }, { ...base, target }, () => true)).status).toBe(expected);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a Slack token for another workspace before posting", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true, team_id: "T99999999", user_id: "U12345678" }));
    const result = await sendSlackPublication({ config: () => ({ enabled: true, botToken: "test-token" }), fetcher }, { ...base, target: slack }, () => true);
    expect(result).toEqual({ status: "failed", error_code: "slack_workspace_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("posts Slack text without mention expansion and includes a clickable article link", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ok: true, team_id: slack.team_id, user_id: "U12345678" }))
      .mockResolvedValueOnce(json({ ok: true, channel: { id: slack.channel_id, is_archived: false, is_member: true, is_im: false, is_mpim: false } }))
      .mockResolvedValueOnce(json({ ok: true, channel: slack.channel_id, ts: "1789100000.000001" }));
    const result = await sendSlackPublication({ config: () => ({ enabled: true, botToken: "test-token" }), fetcher }, { ...base, target: slack }, () => true);
    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(body).toMatchObject({ mrkdwn: false, parse: "none", link_names: false, unfurl_links: false });
    expect(body.text).not.toContain("<!channel>");
    expect(body.blocks[0].text.type).toBe("plain_text");
    expect(body.blocks[1].text.text).toBe(`<${article.url}|記事を読む>`);
  });
});
