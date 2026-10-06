import { describe, it, expect, vi } from "vitest";
import { ChannelType, type Guild, type Interaction } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { parseHumanCommandRequests, MAX_COMMAND_LENGTH } from "./human-command-marker.js";
import { humanRequestHeader, parseHumanRequestOk, startHumanRequestDiscord } from "./human-request.js";

const fence = (body: string) => `前置き\n\`\`\`human-command\n${body}\n\`\`\`\n後書き`;

describe("parseHumanCommandRequests", () => {
  it("説明とコマンドを取り出し、先頭の ! を外す", () => {
    expect(parseHumanCommandRequests(fence('{"description":"gh の再認証","command":"! gh auth login"}')))
      .toEqual([{ description: "gh の再認証", command: "gh auth login" }]);
  });

  it("壊れた JSON・空コマンド・長すぎるコマンドは無視する", () => {
    expect(parseHumanCommandRequests(fence("{not json"))).toEqual([]);
    expect(parseHumanCommandRequests(fence('{"command":"!  "}'))).toEqual([]);
    expect(parseHumanCommandRequests(fence(JSON.stringify({ command: "x".repeat(MAX_COMMAND_LENGTH + 1) })))).toEqual([]);
    expect(parseHumanCommandRequests("```ask\n{\"command\":\"ls\"}\n```")).toEqual([]);
  });

  it("マーカーが無くても「`! <command>`」の形を拾い、その行を説明にする (2026-10-06)", () => {
    const text = [
      "分類器に止められたので、次を実行してください: `! gh auth login`",
      "`!important` や `!=` は拾わない。`! gh auth login` の重複も 1 件にする。",
      fence('{"description":"マーカー","command":"npm run build"}'),
    ].join("\n");
    expect(parseHumanCommandRequests(text)).toEqual([
      { description: "マーカー", command: "npm run build" },
      { description: "分類器に止められたので、次を実行してください:", command: "gh auth login" },
    ]);
  });

  it("CRLF と複数ブロックを扱う", () => {
    const text = '```human-command\r\n{"command":"a"}\r\n```\n```human-command\n{"command":"b"}\n```';
    expect(parseHumanCommandRequests(text).map((request) => request.command)).toEqual(["a", "b"]);
  });
});

describe("human request posts", () => {
  it("説明投稿に関連セッションを載せ、OK ボタン ID を解釈する", () => {
    expect(humanRequestHeader({ description: "理由", command: "ls" }, "https://discord.com/channels/1/2")).toContain("関連セッション: https://discord.com/channels/1/2");
    expect(parseHumanRequestOk("human-request:ok:123456789012345678")).toBe("123456789012345678");
    expect(parseHumanRequestOk("human-request:ok:abc")).toBeNull();
  });

  function fakeGuild() {
    const sent: { id: string; content: string; components?: unknown[] }[] = [];
    const deleted: string[] = [];
    const channel = {
      id: "900000000000000001",
      type: ChannelType.GuildText,
      send: vi.fn(async (payload: { content: string; components?: unknown[] }) => {
        const message = { id: String(100000000000000000n + BigInt(sent.length)), ...payload };
        sent.push(message);
        return message;
      }),
      messages: { delete: vi.fn(async (id: string) => { deleted.push(id); }) },
    };
    const guild = {
      id: "800000000000000001",
      client: { user: { id: "bot" } },
      channels: { fetch: vi.fn(async () => channel) },
    } as unknown as Guild;
    const store = new Map<string, string>([["human_request_channel_id", channel.id]]);
    const config = { get: (key: string) => store.get(key) ?? null, set: (key: string, value: string) => store.set(key, value) } as unknown as DiscordConfigRepo;
    (guild as unknown as { channels: { cache: Map<string, unknown> } }).channels.cache = new Map([[channel.id, { ...channel, parentId: "cat" }]]);
    return { guild, config, channel, sent, deleted };
  }

  it("説明・コマンドだけ・OK ボタンの順に 1 回だけ投稿し、OK でコマンド投稿を消す", async () => {
    const h = fakeGuild();
    const surface = await startHumanRequestDiscord({
      guild: h.guild, config: h.config, parentId: "cat", sessionUrl: () => "https://discord.com/channels/1/2",
      allowed: (userId) => userId === "neco", log: { warn: () => undefined },
    });
    const message = { sessionId: "s", messageId: 7, authorType: "assistant", content: fence('{"description":"理由","command":"!gh auth login"}') };
    await surface.onSessionMessage(message);
    await surface.onSessionMessage(message); // update 再配送
    await surface.onSessionMessage({ ...message, messageId: 8, authorType: "user" });
    expect(h.sent.map((item) => item.content)).toEqual([
      expect.stringContaining("関連セッション"),
      "gh auth login",
      expect.stringContaining("OK"),
    ]);

    const commandId = h.sent[1]!.id;
    const deny = vi.fn();
    const button = (userId: string) => ({
      isButton: () => true, customId: `human-request:ok:${commandId}`, guildId: h.guild.id, channelId: h.channel.id,
      message: { author: { id: "bot" } }, user: { id: userId }, reply: deny, deferUpdate: vi.fn(), editReply: vi.fn(),
    });
    const stranger = button("someone");
    expect(surface.handlesInteraction(stranger as unknown as Interaction)).toBe(true);
    await surface.interaction(stranger as unknown as Interaction);
    expect(deny).toHaveBeenCalled();
    expect(h.deleted).toEqual([]);

    const owner = button("neco");
    await surface.interaction(owner as unknown as Interaction);
    expect(h.deleted).toEqual([commandId]);
    expect(owner.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
});
