import { describe, it, expect } from "vitest";
import { ChannelType } from "discord.js";
import type { Guild } from "discord.js";
import { ensureDiscordLayout } from "./config.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";

/** ensureDiscordLayout 用の最小 fake Guild / repo。 channels.create を記録する。 */
function makeFakeGuild() {
  const channels = new Map<string, { id: string; name: string; type: ChannelType; parentId: string | null }>();
  let counter = 0;
  const created: Array<{ name: string; type: ChannelType }> = [];
  const guild = {
    id: "guild-1",
    channels: {
      cache: {
        get: (id: string) => channels.get(id),
        find: (fn: (c: { id: string; name: string; type: ChannelType; parentId: string | null }) => boolean) => {
          for (const c of channels.values()) if (fn(c)) return c;
          return undefined;
        },
      },
      create: async ({ name, type, parent }: { name: string; type: ChannelType; parent?: string }) => {
        const id = `ch-${counter++}`;
        const ch = { id, name, type, parentId: parent ?? null, edit: async () => {} };
        channels.set(id, ch);
        created.push({ name, type });
        return ch;
      },
    },
  } as unknown as Guild;
  return { guild, created };
}

function makeFakeRepo(): DiscordConfigRepo {
  const store = new Map<string, string>();
  return {
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => { store.set(k, v); },
  } as unknown as DiscordConfigRepo;
}

describe("ensureDiscordLayout", () => {
  it("既定 (本社) は雑談 meta / pr-queue / errors を全部作る", async () => {
    const { guild, created } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo());

    expect(snap.prQueueChannelId).not.toBe("");
    expect(snap.errorChannelId).not.toBe("");
    expect(snap.errorCategoryId).not.toBe("");
    expect(Object.keys(snap.metaChannels).length).toBeGreaterThan(0);

    const names = created.map((c) => c.name);
    expect(names).toContain("pr-queue");
    expect(names).toContain("errors");
    expect(names).toContain("雑談");
  });

  it("slim (子会社) は雑談 meta / pr-queue / errors を作らず空 id を返す", async () => {
    const { guild, created } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo(), {
      includeMetaChannels: false,
      includePrQueue: false,
      includeErrors: false,
    });

    expect(snap.prQueueChannelId).toBe("");
    expect(snap.errorChannelId).toBe("");
    expect(snap.errorCategoryId).toBe("");
    expect(Object.keys(snap.metaChannels).length).toBe(0);

    // meta カテゴリ自体は受付チャンネルの親として残す。
    expect(snap.metaCategoryId).not.toBe("");

    const names = created.map((c) => c.name);
    expect(names).not.toContain("pr-queue");
    expect(names).not.toContain("errors");
    expect(names).not.toContain("雑談");
    // セッション系 (コスト / monitor) は子会社でも作る。
    expect(names).toContain("concordia-monitor");
  });
});
