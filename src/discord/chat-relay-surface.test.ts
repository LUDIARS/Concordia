// @implements spec/feature/discord-chat-relay.md — 受信 / サービスの応答と Discord への投稿
// Discord クライアントは使わず、 Message の必要部分だけの代役で判定・転送・投稿・ログを確かめる。
import { describe, expect, it, vi } from "vitest";
import type { RelayInput, RelayOutcome } from "../line-webhook/relay.js";
import { createDiscordChatRelayService } from "../discord-chat-relay/relay-service.js";
import type { DiscordChatRelayTarget } from "../discord-chat-relay/targets.js";
import { createChatRelaySurface, type ChatRelaySurfaceMessage } from "./chat-relay-surface.js";

const FAMILY = "123456789012345678";
const THREAD = "323456789012345678";
const BOT = "723456789012345678";
/** テスト値 (実物ではない)。 */
const TOKEN = "example-relay-token";

const target: DiscordChatRelayTarget = {
  name: "mf", url: "http://192.0.2.10/integrations/discord", host: null, channelIds: [FAMILY], enabled: true,
};

function stubMessage(overrides: Partial<ChatRelaySurfaceMessage> = {}, thread = false) {
  const reply = vi.fn(async () => ({}));
  const msg: ChatRelaySurfaceMessage = {
    id: "423456789012345678", guildId: "523456789012345678", channelId: thread ? THREAD : FAMILY,
    content: "  今日の連絡帳なに書こう  ", webhookId: null, system: false, createdAt: new Date("2026-10-18T07:00:00.000Z"),
    author: { id: "623456789012345678", bot: false, username: "neco-user", globalName: "neco-global" },
    member: { displayName: "neco" },
    mentions: { users: { has: (id: string) => id === BOT } },
    channel: { isThread: () => thread, parentId: thread ? FAMILY : null },
    reply,
    ...overrides,
  };
  return { msg, reply };
}

function setup(outcome: RelayOutcome, sessionChannels: string[] = []) {
  const send = vi.fn(async (_input: RelayInput) => outcome);
  const log = { info: vi.fn(), warn: vi.fn() };
  const surface = createChatRelaySurface({
    service: createDiscordChatRelayService({ targets: () => [target], relayToken: () => TOKEN, send }),
    isSessionRelayChannel: (id) => sessionChannels.includes(id),
    botUserId: () => BOT,
    log,
  });
  return { surface, send, log };
}

const replied = (json: unknown, status = 200): RelayOutcome =>
  ({ kind: "response", status, body: Buffer.from(JSON.stringify(json)), contentType: "application/json" });

describe("createChatRelaySurface", () => {
  it("登録チャンネルの人間の発言を受け持ち、返事を元の発言への返信として順に投稿する", async () => {
    const { surface, send } = setup(replied({ replies: [{ text: "どうぞ" }, { text: "例: 公園" }] }));
    const { msg, reply } = stubMessage();
    expect(surface.handlesMessage(msg)).toBe(true);
    await surface.message(msg);
    const body = JSON.parse(Buffer.from(send.mock.calls[0]![0].body).toString("utf8"));
    expect(body).toMatchObject({ channelId: FAMILY, threadId: null, text: "今日の連絡帳なに書こう", mentionsBot: true, author: { displayName: "neco" } });
    expect(reply.mock.calls).toEqual([
      [{ content: "どうぞ", allowedMentions: { parse: [], repliedUser: false } }],
      [{ content: "例: 公園", allowedMentions: { parse: [], repliedUser: false } }],
    ]);
  });

  it("スレッド内の発言はスレッド ID を付けて転送する", async () => {
    const { surface, send } = setup(replied({ replies: [] }));
    const { msg } = stubMessage({}, true);
    expect(surface.handlesMessage(msg)).toBe(true);
    await surface.message(msg);
    expect(JSON.parse(Buffer.from(send.mock.calls[0]![0].body).toString("utf8"))).toMatchObject({ channelId: FAMILY, threadId: THREAD });
  });

  it.each([
    ["bot の発言", { author: { id: BOT, bot: true, username: "cc" } }],
    ["webhook の発言", { webhookId: "823456789012345678" }],
    ["システムメッセージ", { system: true }],
    ["guild 外", { guildId: null }],
    ["未登録チャンネル", { channelId: "999999999999999999" }],
  ])("%s は受け持たない", (_label, overrides) => {
    const { surface } = setup(replied({ replies: [] }));
    expect(surface.handlesMessage(stubMessage(overrides as Partial<ChatRelaySurfaceMessage>).msg)).toBe(false);
  });

  it("セッション中継と重なるチャンネルは受け持たず、target 名と種別だけをログに残す", () => {
    const { surface, log } = setup(replied({ replies: [] }), [FAMILY]);
    expect(surface.handlesMessage(stubMessage().msg)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith("discord chat relay target=mf failure=session_channel_conflict");
  });

  it("本文が空の発言は受け持つが転送しない", async () => {
    const { surface, send } = setup(replied({ replies: [] }));
    const { msg, reply } = stubMessage({ content: "   " });
    expect(surface.handlesMessage(msg)).toBe(true);
    await surface.message(msg);
    expect(send).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("失敗は投稿せず、ログに本文・名前・トークンを出さない", async () => {
    const { surface, log } = setup(replied({ error: "x" }, 502));
    const { msg, reply } = stubMessage();
    await surface.message(msg);
    expect(reply).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("discord chat relay target=mf failure=upstream_status status=502");
    const logged = JSON.stringify([...log.warn.mock.calls, ...log.info.mock.calls]);
    for (const secret of ["連絡帳", "neco", TOKEN]) expect(logged).not.toContain(secret);
  });

  it("再接続で同じ発言が届いても 1 回だけ転送する", async () => {
    const { surface, send, log } = setup(replied({ replies: [{ text: "どうぞ" }] }));
    const first = stubMessage();
    const again = stubMessage();
    await surface.message(first.msg);
    await surface.message(again.msg);
    expect(send).toHaveBeenCalledTimes(1);
    expect(again.reply).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("discord chat relay target=mf skipped=duplicate_message");
  });

  it("投稿に失敗したら残りの返事は出さずにログに残す", async () => {
    const { surface, log } = setup(replied({ replies: [{ text: "1" }, { text: "2" }] }));
    const { msg, reply } = stubMessage();
    reply.mockRejectedValueOnce(new Error("Missing Permissions"));
    await surface.message(msg);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("discord chat relay target=mf failure=post_failed");
  });
});
