import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild, type Message, type Interaction } from "discord.js";
import { choreCard, startChoresDiscord } from "./chores.js";
import type { Chore } from "../chores/domain.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const row: Chore = { id: "00000000-0000-4000-8000-000000000001", request_key: "a", prompt: "依頼 @everyone", provider: "claude",
  status: "succeeded", cwd: "/chores/a", output: "結果", error: null, spawn_id: null, created_at: 1, updated_at: 2,
  revision: 3, delivered_revision: 0, discord_message_id: null };
describe("Discord chores", () => {
  it("renders actual OK/Continue controls and suppresses mentions", () => {
    const card = choreCard(row);
    expect(card.allowedMentions.parse).toEqual([]);
    expect(card.components[0].toJSON().components.map(b => "label" in b ? b.label : null)).toEqual(["OK", "Continue"]);
    expect(card.components[0].toJSON().components.every(b => !b.disabled)).toBe(true);
    expect(choreCard({ ...row, status: "continued" }).components[0].toJSON().components.every(b => b.disabled)).toBe(true);
  });
  it("ignores bots, denies unauthorized callers and accepts a human in the dedicated channel", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(JSON.stringify({ run: row }), { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    const channel = { id: "channel", type: ChannelType.GuildText, name: "雑務" };
    const guild = { id: "guild", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild;
    const config = { get: () => "channel", set: vi.fn() } as unknown as DiscordConfigRepo;
    const surface = await startChoresDiscord({ guild, config, parentId: "parent", baseUrl: "http://cc", allowed: id => id === "human", log: { warn: vi.fn() } });
    const message = { guildId: "guild", channelId: "channel", id: "message", author: { id: "human", bot: false }, webhookId: null, content: "[codex] 依頼", reply: vi.fn() };
    expect(surface.handlesMessage(message as unknown as Message)).toBe(true);
    expect(surface.handlesMessage({ ...message, guildId: "other" } as unknown as Message)).toBe(false);
    await surface.message({ ...message, author: { id: "bot", bot: true } } as unknown as Message);
    await surface.message({ ...message, author: { id: "other", bot: false } } as unknown as Message);
    expect(fetcher).not.toHaveBeenCalled();
    await surface.message(message as unknown as Message);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({ provider: "codex", prompt: "依頼", request_key: "discord:guild:message" });
    surface.stopChores();
  });
  it("rejects copied buttons outside the dedicated channel", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const channel = { id: "channel", type: ChannelType.GuildText };
    const guild = { id: "guild", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild;
    const surface = await startChoresDiscord({ guild, config: { get: () => "channel", set: vi.fn() } as unknown as DiscordConfigRepo,
      parentId: "p", baseUrl: "http://cc", allowed: () => true, log: { warn: vi.fn() } });
    const interaction = { isButton: () => true, guildId: "guild", channelId: "other", message: { author: { id: "bot" } },
      user: { id: "human" }, customId: `chore:${row.id}:continue`, reply: vi.fn() };
    await surface.interaction(interaction as unknown as Interaction);
    expect(interaction.reply).toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); surface.stopChores();
  });
});
