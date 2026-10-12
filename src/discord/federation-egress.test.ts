import { describe, expect, it } from "vitest";
import { createFederationEgressExecutor, resolveEgressTarget, type EgressChannel, type EgressSendOptions } from "./federation-egress.js";

const GUILD = "100000000000000001";
const TEXT = "200000000000000002";
const THREAD = "300000000000000003";

function channel(input: { thread: boolean; parentId?: string | null; guildId?: string }): EgressChannel {
  return { guildId: input.guildId ?? GUILD, isThread: () => input.thread, parentId: input.parentId ?? null };
}

function setup(channels: Record<string, EgressChannel>, opts: { webhookChannels?: string[]; sendOk?: boolean; reactOk?: boolean } = {}) {
  const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  const webhookRequests: string[] = [];
  const sent: EgressSendOptions[] = [];
  const warnings: string[] = [];
  const webhookChannels = new Set(opts.webhookChannels ?? [TEXT]);
  const execute = createFederationEgressExecutor({
    guildId: GUILD,
    fetchChannel: async (id) => channels[id] ?? null,
    getWebhook: async (id) => {
      webhookRequests.push(id);
      return webhookChannels.has(id) ? { id: `wh-${id}` } : null;
    },
    send: async (_client, options) => {
      sent.push(options);
      return opts.sendOk === false ? null : { id: "m1" };
    },
    react: async (channelId, messageId, emoji) => {
      reactions.push({ channelId, messageId, emoji });
      return opts.reactOk !== false;
    },
    log: { warn: (message) => warnings.push(message) },
  });
  return { execute, webhookRequests, sent, warnings, reactions };
}

describe("resolveEgressTarget", () => {
  it("sends to a text channel's own webhook", () => {
    expect(resolveEgressTarget(TEXT, channel({ thread: false }))).toEqual({ webhookChannelId: TEXT });
  });

  it("uses the parent webhook with thread_id for a thread", () => {
    expect(resolveEgressTarget(THREAD, channel({ thread: true, parentId: TEXT }))).toEqual({ webhookChannelId: TEXT, threadId: THREAD });
  });

  it("rejects a thread without a parent", () => {
    expect(resolveEgressTarget(THREAD, channel({ thread: true, parentId: null }))).toBeNull();
  });
});

describe("createFederationEgressExecutor", () => {
  it("relays a site message into the /spawn site thread via the parent channel webhook", async () => {
    const { execute, webhookRequests, sent } = setup({ [THREAD]: channel({ thread: true, parentId: TEXT }) });
    const result = await execute({ guild_id: GUILD, channel_id: THREAD, text: "拠点でセッションを起動しました。" });
    expect(result).toEqual({ ok: true });
    expect(webhookRequests).toEqual([TEXT]);
    expect(sent[0]).toMatchObject({ content: "拠点でセッションを起動しました。", threadId: THREAD, allowedMentions: { parse: [] } });
  });

  it("sends to a text channel without thread_id", async () => {
    const { execute, sent } = setup({ [TEXT]: channel({ thread: false }) });
    expect(await execute({ guild_id: GUILD, channel_id: TEXT, text: "hi" })).toEqual({ ok: true });
    expect(sent[0]?.threadId).toBeUndefined();
  });

  it("rejects another guild and logs the rejection on HQ", async () => {
    const { execute, warnings, sent } = setup({ [TEXT]: channel({ thread: false }) });
    const result = await execute({ guild_id: "999999999999999999", channel_id: TEXT, text: "x" });
    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(warnings[0]).toContain(`channel=${TEXT}`);
  });

  it("rejects a channel that belongs to another guild", async () => {
    const { execute } = setup({ [TEXT]: channel({ thread: false, guildId: "999999999999999999" }) });
    expect((await execute({ guild_id: GUILD, channel_id: TEXT, text: "x" })).ok).toBe(false);
  });

  it("reports a missing webhook and a failed send", async () => {
    const missing = setup({ [THREAD]: channel({ thread: true, parentId: TEXT }) }, { webhookChannels: [] });
    expect(await missing.execute({ guild_id: GUILD, channel_id: THREAD, text: "x" })).toEqual({ ok: false, error: "Discord webhook is unavailable for destination channel" });
    const failed = setup({ [TEXT]: channel({ thread: false }) }, { sendOk: false });
    expect(await failed.execute({ guild_id: GUILD, channel_id: TEXT, text: "x" })).toEqual({ ok: false, error: "Discord send failed" });
    expect(failed.warnings).toHaveLength(1);
  });
});

describe("HQ reply ✅ from the site (SPEC-FED-SITE-FORUM-PARITY)", () => {
  const MESSAGE = "400000000000000004";

  it("reacts ✅ on the HQ message instead of posting the text", async () => {
    const { execute, sent, reactions, webhookRequests } = setup({ [THREAD]: channel({ thread: true, parentId: TEXT }) });
    expect(await execute({ guild_id: GUILD, channel_id: THREAD, text: "✅", ack_message_id: MESSAGE })).toEqual({ ok: true });
    expect(reactions).toEqual([{ channelId: THREAD, messageId: MESSAGE, emoji: "✅" }]);
    expect(sent).toHaveLength(0);
    expect(webhookRequests).toHaveLength(0);
  });

  it("keeps the guild check and reports a failed or invalid reaction", async () => {
    const other = setup({ [THREAD]: channel({ thread: true, parentId: TEXT, guildId: "999999999999999999" }) });
    expect((await other.execute({ guild_id: GUILD, channel_id: THREAD, text: "✅", ack_message_id: MESSAGE })).ok).toBe(false);
    expect(other.reactions).toHaveLength(0);
    const failed = setup({ [THREAD]: channel({ thread: true, parentId: TEXT }) }, { reactOk: false });
    expect(await failed.execute({ guild_id: GUILD, channel_id: THREAD, text: "✅", ack_message_id: MESSAGE })).toEqual({ ok: false, error: "Discord reaction failed" });
    const invalid = setup({ [THREAD]: channel({ thread: true, parentId: TEXT }) });
    expect(await invalid.execute({ guild_id: GUILD, channel_id: THREAD, text: "✅", ack_message_id: "x" })).toEqual({ ok: false, error: "ack message id is invalid" });
  });
});
