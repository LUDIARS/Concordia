import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import {
  createMuseInstructionsPoster,
  ensureMuseInstructionsChannel,
  MUSE_INSTRUCTIONS_CHANNEL_CONFIG_KEY,
  type InstructionPostChannel,
} from "./muse-instructions-channel.js";

type FakeChannel = { id: string; name: string; type: ChannelType; parentId: string | null; setParent: ReturnType<typeof vi.fn> };

function fakeConfig(initial: Record<string, string> = {}): DiscordConfigRepo {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
    compareAndSwap: () => false,
    all: () => Object.fromEntries(values),
  };
}

function channel(id: string, name: string, parentId: string | null, type = ChannelType.GuildText): FakeChannel {
  return { id, name, type, parentId, setParent: vi.fn(async () => undefined) };
}

function fakeGuild(channels: FakeChannel[]) {
  const cache = new Map(channels.map((c) => [c.id, c]));
  const create = vi.fn(async (options: { name: string }) => {
    const created = channel("new", options.name, null);
    cache.set(created.id, created);
    return created;
  });
  return { guild: { channels: { cache, create } } as never, create };
}

const log = { warn: vi.fn() };

describe("muse-指令 channel (ensure)", () => {
  it("トップレベルのテキストチャンネルとして作り、 id を保存する", async () => {
    const { guild, create } = fakeGuild([]);
    const config = fakeConfig();
    const made = await ensureMuseInstructionsChannel({ guild, config, log });
    expect(made.id).toBe("new");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "muse-指令", type: ChannelType.GuildText }));
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ parent: expect.anything() }));
    expect(config.get(MUSE_INSTRUCTIONS_CHANNEL_CONFIG_KEY)).toBe("new");
  });

  it("保存済み id → 同名の順で探し、 カテゴリに入っていれば外へ出す", async () => {
    const saved = channel("saved", "renamed-by-human", null);
    const byName = channel("byname", "muse-指令", "cat");
    const first = fakeGuild([saved, byName]);
    expect((await ensureMuseInstructionsChannel({ guild: first.guild, config: fakeConfig({ [MUSE_INSTRUCTIONS_CHANNEL_CONFIG_KEY]: "saved" }), log })).id).toBe("saved");
    const second = fakeGuild([byName]);
    const config = fakeConfig();
    expect((await ensureMuseInstructionsChannel({ guild: second.guild, config, log })).id).toBe("byname");
    expect(second.create).not.toHaveBeenCalled();
    expect(byName.setParent).toHaveBeenCalledWith(null, expect.anything());
    expect(config.get(MUSE_INSTRUCTIONS_CHANNEL_CONFIG_KEY)).toBe("byname");
  });
});

describe("muse-指令 channel (poster)", () => {
  function fakeChannel() {
    let seq = 0;
    const sent: Array<Parameters<InstructionPostChannel["send"]>[0]> = [];
    const target: InstructionPostChannel = { send: vi.fn(async (options) => { sent.push(options); return { id: `m${seq++}` }; }) };
    return { target, sent };
  }
  const id = "inst:muse:20261123T000000Z:abcdef";

  it("posts the registration, then replies to it for ack / result / requeue with mentions disabled", async () => {
    const { target, sent } = fakeChannel();
    const post = createMuseInstructionsPoster(target);
    await post({ kind: "registered", id, agent: "muse", type: "run_task", title: "t", body: "@everyone b", createdAt: "x" });
    await post({ kind: "acked", id, agent: "muse", title: "t", ackedAt: "y" });
    await post({ kind: "finished", id, agent: "muse", title: "t", status: "done", summary: "ok", detail: null, finishedAt: "z" });
    await post({ kind: "requeued", id, agent: "muse", title: "t" });
    expect(sent.map((s) => s.reply?.messageReference ?? null)).toEqual([null, "m0", "m0", "m0"]);
    expect(sent.every((s) => s.allowedMentions.parse.length === 0)).toBe(true);
    expect(sent[1]?.reply?.failIfNotExists).toBe(false);
    expect(sent[0]?.content).not.toContain("@everyone");
  });

  it("posts with the id but without a reply when the registration post is unknown (e.g. after a restart), and forgets the oldest", async () => {
    const { target, sent } = fakeChannel();
    const post = createMuseInstructionsPoster(target, 1);
    await post({ kind: "acked", id, agent: "muse", title: "t", ackedAt: "y" });
    expect(sent[0]?.reply).toBeUndefined();
    expect(sent[0]?.content).toContain(id);
    const other = "inst:dots:20261123T000000Z:000001";
    await post({ kind: "registered", id, agent: "muse", type: "run_task", title: "t", body: "b", createdAt: "x" });
    await post({ kind: "registered", id: other, agent: "dots", type: "run_task", title: "t", body: "b", createdAt: "x" });
    await post({ kind: "acked", id, agent: "muse", title: "t", ackedAt: "y" });
    await post({ kind: "acked", id: other, agent: "dots", title: "t", ackedAt: "y" });
    expect(sent.slice(3).map((s) => s.reply?.messageReference ?? null)).toEqual([null, "m2"]);
  });

  it("propagates a send failure to the relay (which only warns)", async () => {
    const failing: InstructionPostChannel = { send: vi.fn(async () => { throw new Error("Missing Access"); }) };
    await expect(createMuseInstructionsPoster(failing)({ kind: "requeued", id, agent: "muse", title: "t" })).rejects.toThrow("Missing Access");
  });
});
