import { ChannelType } from "discord.js";
import type { Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrivateChannelsRepo } from "../db/private-channels-repo.js";
import { createPrivateChannelProvisioner } from "./private-channel-provisioner.js";

const NECO = "123456789012345678";

function setup(options: { createFails?: boolean } = {}) {
  const repo = new PrivateChannelsRepo(makeTestDb());
  const send = vi.fn(async () => ({ id: "m-1" }));
  const edit = vi.fn(async () => undefined);
  const channel = { id: "c-1", type: ChannelType.GuildText, send, permissionOverwrites: { edit } };
  const created: Array<Record<string, unknown>> = [];
  const guild = {
    id: "g-1",
    client: { user: { id: "bot-1" } },
    roles: { everyone: { id: "everyone-role" } },
    channels: {
      cache: { find: () => undefined },
      fetch: vi.fn(async (id: string) => (id === "c-1" ? channel : null)),
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        if (input.type === ChannelType.GuildCategory) return { id: "cat-1", type: ChannelType.GuildCategory };
        if (options.createFails) throw new Error("Missing Permissions");
        return channel;
      }),
    },
  } as unknown as Guild;
  let categoryId: string | null = null;
  const provisioner = createPrivateChannelProvisioner({
    guild,
    repo,
    categoryStore: { categoryId: () => categoryId, setCategoryId: (id) => { categoryId = id; } },
    log: { info: vi.fn(), warn: vi.fn() },
  });
  return { repo, provisioner, created, send, edit };
}

const request = { request_key: null, name: "report-for-neco", viewer_user_ids: [NECO], initial_text: "最初の投稿", created_by_session_id: null };

describe("private channel provisioner", () => {
  it("creates a closed channel, posts the first message and marks it ready (CC-PRIVCH-INV-01)", async () => {
    const ctx = setup();
    const row = ctx.repo.create(request);
    await ctx.provisioner.provision(row.id);
    const channelRequest = ctx.created.find((c) => c.type === ChannelType.GuildText)!;
    expect(channelRequest).toMatchObject({ name: "report-for-neco", parent: "cat-1" });
    expect((channelRequest.permissionOverwrites as Array<{ id: string }>).map((o) => o.id)).toEqual(["everyone-role", NECO, "bot-1"]);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ content: "最初の投稿" }));
    expect(ctx.repo.find(row.id)).toMatchObject({ status: "ready", channel_id: "c-1", guild_id: "g-1", initial_message_id: "m-1" });
  });

  it("resumes a recorded channel without creating another (CC-PRIVCH-INV-02)", async () => {
    const ctx = setup();
    const row = ctx.repo.create(request);
    ctx.repo.recordChannel(row.id, { guild_id: "g-1", channel_id: "c-1" });
    await ctx.provisioner.reconcile();
    expect(ctx.created.filter((c) => c.type === ChannelType.GuildText)).toHaveLength(0);
    expect(ctx.edit).toHaveBeenCalledWith(NECO, expect.objectContaining({ ViewChannel: true }), expect.anything());
    expect(ctx.repo.find(row.id)?.status).toBe("ready");
  });

  it("records the failure reason and does not retry by itself", async () => {
    const ctx = setup({ createFails: true });
    const row = ctx.repo.create(request);
    await ctx.provisioner.provision(row.id);
    expect(ctx.repo.find(row.id)).toMatchObject({ status: "failed", error: "Missing Permissions" });
    await ctx.provisioner.reconcile();
    expect(ctx.created.filter((c) => c.type === ChannelType.GuildText)).toHaveLength(1);
  });
});
