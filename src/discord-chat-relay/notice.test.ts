// @implements spec/feature/discord-chat-relay.md — お知らせチャンネル
import { describe, expect, it, vi } from "vitest";
import type { RelayInput, RelayOutcome } from "../line-webhook/relay.js";
import type { LineNoticePusher } from "../line-webhook/notice-push.js";
import { createMessageLedger } from "./message-ledger.js";
import { parseDiscordNoticeAnswer } from "./notice-answer.js";
import { buildDiscordNoticePayload, hasNoticeContent, isDiscordNoticeAuthor, type DiscordNoticeMessage } from "./notice.js";
import { createDiscordChatRelayService } from "./relay-service.js";
import { routeDiscordNotice } from "./routing.js";
import type { DiscordChatRelayTarget } from "./targets.js";

const FAMILY = "123456789012345678";
const NOTICE = "223456789012345678";
const THREAD = "323456789012345678";
const SELF = "723456789012345678";
const BUS_WEBHOOK = "923456789012345678";
/** テスト値 (実物ではない)。 */
const TOKEN = "example-relay-token";

const target: DiscordChatRelayTarget = {
  name: "mf", url: "http://192.0.2.10:8080/integrations/discord", host: null,
  channelIds: [FAMILY], noticeChannelIds: [NOTICE], enabled: true,
};
const route = { kind: "relay" as const, target, channelId: NOTICE, threadId: null };

function notice(overrides: Partial<DiscordNoticeMessage> = {}): DiscordNoticeMessage {
  return {
    messageId: "423456789012345678", guildId: "523456789012345678", authorId: BUS_WEBHOOK,
    authorDisplayName: "おおぞらバス", webhookId: BUS_WEBHOOK, text: "バスが 5 分遅れています",
    embeds: [{ title: "運行情報", description: null, fields: [{ name: "便", value: "朝便" }] }],
    sentAt: new Date("2026-10-19T07:00:00.000Z"), ...overrides,
  };
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const okResponse = (value: unknown, status = 200): RelayOutcome =>
  ({ kind: "response", status, body: json(value), contentType: "application/json" });

describe("isDiscordNoticeAuthor", () => {
  const facts = { authorId: BUS_WEBHOOK, authorIsBot: true, webhookId: null, system: false };

  it("他の bot・webhook の投稿だけを拾う", () => {
    expect(isDiscordNoticeAuthor(facts, SELF)).toBe(true);
    expect(isDiscordNoticeAuthor({ ...facts, authorIsBot: false, webhookId: BUS_WEBHOOK }, SELF)).toBe(true);
  });

  it("人の発言・システムメッセージ・Cc 自身の bot・自分が分からないときは拾わない", () => {
    expect(isDiscordNoticeAuthor({ ...facts, authorIsBot: false }, SELF)).toBe(false);
    expect(isDiscordNoticeAuthor({ ...facts, system: true }, SELF)).toBe(false);
    expect(isDiscordNoticeAuthor({ ...facts, authorId: SELF }, SELF)).toBe(false);
    expect(isDiscordNoticeAuthor(facts, null)).toBe(false);
  });
});

describe("routeDiscordNotice", () => {
  const off: DiscordChatRelayTarget = { ...target, name: "off", noticeChannelIds: ["623456789012345678"], enabled: false };

  it("お知らせのチャンネルとその子スレッドだけを振り、発言のチャンネルは振らない", () => {
    expect(routeDiscordNotice([target], { channelId: NOTICE, parentId: null }, () => false))
      .toMatchObject({ kind: "relay", target: { name: "mf" }, channelId: NOTICE, threadId: null });
    expect(routeDiscordNotice([target], { channelId: THREAD, parentId: NOTICE }, () => false))
      .toMatchObject({ kind: "relay", channelId: NOTICE, threadId: THREAD });
    expect(routeDiscordNotice([target], { channelId: FAMILY, parentId: null }, () => false)).toEqual({ kind: "none" });
    expect(routeDiscordNotice([off], { channelId: "623456789012345678", parentId: null }, () => false)).toEqual({ kind: "none" });
  });

  it("セッション中継と重なれば conflict", () => {
    expect(routeDiscordNotice([target], { channelId: NOTICE, parentId: null }, (id) => id === NOTICE))
      .toMatchObject({ kind: "conflict", target: { name: "mf" } });
  });
});

describe("buildDiscordNoticePayload / hasNoticeContent", () => {
  it("版 1 に kind: notice を足し、埋め込みは文字部分だけにする", () => {
    expect(buildDiscordNoticePayload(notice(), { channelId: NOTICE, threadId: null })).toEqual({
      version: 1, kind: "notice", messageId: "423456789012345678", channelId: NOTICE, threadId: null,
      guildId: "523456789012345678",
      author: { id: BUS_WEBHOOK, displayName: "おおぞらバス", bot: true, webhookId: BUS_WEBHOOK },
      text: "バスが 5 分遅れています",
      embeds: [{ title: "運行情報", description: null, fields: [{ name: "便", value: "朝便" }] }],
      sentAt: "2026-10-19T07:00:00.000Z",
    });
  });

  it("本文も埋め込みの文字も無ければ送らない", () => {
    expect(hasNoticeContent({ text: " ", embeds: [] })).toBe(false);
    expect(hasNoticeContent({ text: "", embeds: [{ title: null, description: " ", fields: [] }] })).toBe(false);
    expect(hasNoticeContent({ text: "", embeds: [{ title: null, description: "遅延", fields: [] }] })).toBe(true);
  });
});

describe("parseDiscordNoticeAnswer", () => {
  it("replies と linePush (省略は空) を返す", () => {
    expect(parseDiscordNoticeAnswer(json({ replies: [], linePush: [{ text: "バスが遅れています" }] })))
      .toEqual({ replies: [], linePush: [{ text: "バスが遅れています" }] });
    expect(parseDiscordNoticeAnswer(json({ replies: [{ text: "受け取りました" }] })))
      .toEqual({ replies: [{ text: "受け取りました" }], linePush: [] });
  });

  it.each([
    ["JSON でない", Buffer.from("{")],
    ["replies 欠落", json({ linePush: [] })],
    ["linePush が 4 件", json({ replies: [], linePush: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }] })],
    ["linePush が 1000 字超", json({ replies: [], linePush: [{ text: "あ".repeat(1001) }] })],
    ["linePush の text が空", json({ replies: [], linePush: [{ text: "" }] })],
    ["linePush が配列でない", json({ replies: [], linePush: { text: "a" } })],
  ])("%s は null", (_label, body) => {
    expect(parseDiscordNoticeAnswer(body)).toBeNull();
  });
});

describe("createDiscordChatRelayService.forwardNotice", () => {
  function setup(outcome: RelayOutcome, linePush?: LineNoticePusher) {
    const send = vi.fn(async (_input: RelayInput) => outcome);
    const service = createDiscordChatRelayService({
      targets: () => [target], relayToken: () => TOKEN, send, ledger: createMessageLedger(), linePush,
    });
    return { service, send };
  }

  it("kind: notice の本文を target の url へ送り、linePush を target 名の LINE サービスへ頼む", async () => {
    const pusher = vi.fn<LineNoticePusher>(async () => ({ kind: "pushed", talks: 2, sent: 2, failedStatuses: [] }));
    const { service, send } = setup(okResponse({ replies: [], linePush: [{ text: "バスが遅れています" }] }), pusher);
    const result = await service.forwardNotice(notice(), route);
    expect(result).toEqual({
      kind: "replied", target: "mf", replies: [], linePush: { kind: "pushed", talks: 2, sent: 2, failedStatuses: [] },
    });
    const input = send.mock.calls[0]![0];
    expect(input.url).toBe(target.url);
    expect(JSON.parse(Buffer.from(input.body).toString("utf8"))).toMatchObject({ version: 1, kind: "notice", channelId: NOTICE });
    expect(input.headers["x-concordia-discord-target"]).toBe("mf");
    expect(pusher).toHaveBeenCalledWith({ service: "mf", messageId: "423456789012345678", texts: ["バスが遅れています"] });
  });

  it("linePush が無ければ push を頼まない", async () => {
    const pusher = vi.fn<LineNoticePusher>();
    const { service } = setup(okResponse({ replies: [{ text: "受け取りました" }] }), pusher);
    expect(await service.forwardNotice(notice(), route))
      .toEqual({ kind: "replied", target: "mf", replies: [{ text: "受け取りました" }], linePush: null });
    expect(pusher).not.toHaveBeenCalled();
  });

  it("同じ messageId は 1 回だけ、形の違う応答は push しない", async () => {
    const pusher = vi.fn<LineNoticePusher>();
    const { service, send } = setup(okResponse({ replies: [], linePush: [{ text: "" }] }), pusher);
    expect(await service.forwardNotice(notice(), route))
      .toEqual({ kind: "failed", target: "mf", failure: "invalid_response", status: 200 });
    expect(await service.forwardNotice(notice(), route)).toEqual({ kind: "duplicate", target: "mf" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(pusher).not.toHaveBeenCalled();
  });

  it("タイムアウトで結果不明になっても同じ投稿を再送せず push しない", async () => {
    const pusher = vi.fn<LineNoticePusher>();
    const { service, send } = setup({ kind: "unreachable", reason: "timeout" }, pusher);
    expect(await service.forwardNotice(notice(), route))
      .toEqual({ kind: "failed", target: "mf", failure: "timeout", status: null });
    expect(await service.forwardNotice(notice(), route)).toEqual({ kind: "duplicate", target: "mf" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(pusher).not.toHaveBeenCalled();
  });

  it("2xx 以外は失敗の種別と status だけを返す", async () => {
    const { service } = setup(okResponse({ error: "x" }, 503));
    expect(await service.forwardNotice(notice(), route))
      .toEqual({ kind: "failed", target: "mf", failure: "upstream_status", status: 503 });
  });
});
