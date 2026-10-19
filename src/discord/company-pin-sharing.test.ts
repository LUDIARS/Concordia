import { describe, expect, it, vi } from "vitest";
import { ChannelType, MessageType, PermissionFlagsBits, type Client, type Message } from "discord.js";
import { CompanyPinSharing, type CompanyPinSharingDeps } from "./company-pin-sharing.js";

function fixture() {
  const rows = new Map<string, string>();
  const send = vi.fn(async (_payload: unknown) => ({ id: "posted" }));
  const message = { id: "m", channelId: "source", pinned: true, content: "会社の話題 @everyone", url: "https://discord.com/channels/g/source/m" };
  const guild = { id: "g", members: { me: { id: "bot" } }, channels: { fetch: vi.fn() } };
  const base = { guildId: "g", guild, type: ChannelType.GuildText,
    isDMBased: () => false, isTextBased: () => true, isThread: () => false,
    permissionOverwrites: { cache: new Map() }, permissionsFor: () => ({ has: () => true }) };
  const source = { ...base, id: "source", messages: { fetch: vi.fn(async () => message) } };
  const target = { ...base, id: "target", send };
  const fetch = vi.fn(async (id: string) => id === "source" ? source : target);
  const deps: CompanyPinSharingDeps = {
    client: { channels: { fetch } } as unknown as Client,
    config: { compareAndSwap: (key, expected, next) => {
      if ((rows.get(key) ?? null) !== expected) return false;
      if (next === null) rows.delete(key); else rows.set(key, next);
      return true;
    } },
    target: () => ({ guildId: "g", channelId: "target" }), isStopped: () => false,
    isPrivateOrForeign: () => false, log: { warn: vi.fn() },
  };
  const notice = { type: MessageType.ChannelPinnedMessage, channelId: "source", reference: { messageId: "m" } } as Message;
  return { deps, rows, send, source, target, message, fetch, notice };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("company pin sharing delivery", () => {
  it("deduplicates native pin and RWF across recreated runtime using its durable CAS port", async () => {
    const f = fixture();
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle();
    new CompanyPinSharing(f.deps).workflow("memoria-note", { channelId: "source", messageId: "m" });
    await settle();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![0]).toMatchObject({ allowedMentions: { parse: [] }, content: expect.stringContaining(f.message.content) });
    expect(JSON.parse([...f.rows.values()][0]!)).toMatchObject({ state: "sent", messageId: "posted", channelId: "target" });
  });
  it("does not resend an uncertain delivery after restart", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("lost reply"));
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle();
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle();
    expect(f.send).toHaveBeenCalledOnce();
    expect(JSON.parse([...f.rows.values()][0]!)).toMatchObject({ state: "unknown" });
  });
  it("keeps stale sending claims rather than assuming failure", async () => {
    const f = fixture();
    f.rows.set("company-pin-share:g:source:m", '{"state":"sending"}');
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("excludes private or foreign sessions before reading content", async () => {
    const f = fixture(); f.deps.isPrivateOrForeign = () => true;
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects different guilds and restricted readership", async () => {
    const f = fixture(); f.target.guildId = "other";
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle(); expect(f.send).not.toHaveBeenCalled();
    f.target.guildId = "g";
    f.source.permissionOverwrites = { cache: new Map([["role", { id: "role", type: 0,
      allow: { bitfield: 0n }, deny: { bitfield: PermissionFlagsBits.ViewChannel } }]]) };
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle(); expect(f.send).not.toHaveBeenCalled();
  });
  it("stops after reads without reserving or sending and ignores non-save RWF", async () => {
    const f = fixture();
    f.source.messages.fetch.mockImplementation(async () => { f.deps.isStopped = () => true; return f.message; });
    const sharing = new CompanyPinSharing(f.deps);
    sharing.workflow("status-check", { channelId: "source", messageId: "m" });
    expect(f.fetch).not.toHaveBeenCalled();
    sharing.pinNotice(f.notice);
    await settle();
    expect(f.rows.size).toBe(0); expect(f.send).not.toHaveBeenCalled();
  });
  it("attaches long text without loss", async () => {
    const f = fixture(); f.message.content = "日本語".repeat(2000);
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle();
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ files: [{ name: "pinned-content.txt", attachment: Buffer.from(f.message.content, "utf8") }] }));
  });
  it("does not forward private threads, missing permissions, or pins in chitchat itself", async () => {
    const f = fixture();
    f.source.isThread = () => true;
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle(); expect(f.send).not.toHaveBeenCalled(); // no public parent proof
    f.source.isThread = () => false;
    f.target.permissionsFor = () => ({ has: () => false });
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle(); expect(f.send).not.toHaveBeenCalled();
    f.deps.target = () => ({ guildId: "g", channelId: "source" });
    new CompanyPinSharing(f.deps).pinNotice(f.notice);
    await settle(); expect(f.send).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
  });
});
