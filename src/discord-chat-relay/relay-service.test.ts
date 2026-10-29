// @implements spec/feature/discord-chat-relay.md — 転送 / サービスの応答と Discord への投稿
import { describe, expect, it, vi } from "vitest";
import type { RelayInput, RelayOutcome } from "../line-webhook/relay.js";
import { createMessageLedger } from "./message-ledger.js";
import type { DiscordChatMessage } from "./payload.js";
import { buildDiscordRelayHeaders } from "./relay-headers.js";
import { createDiscordChatRelayService } from "./relay-service.js";
import { parseDiscordRelayReplies } from "./replies.js";
import { describeDiscordChatRelaySecrets, readDiscordChatRelayToken, setDiscordChatRelaySecret } from "./secrets.js";
import type { DiscordChatRelayTarget } from "./targets.js";

const FAMILY = "123456789012345678";
const THREAD = "323456789012345678";
/** テスト値 (実物ではない)。 */
const TOKEN = "example-relay-token";

const target: DiscordChatRelayTarget = {
  name: "mf", url: "http://192.0.2.10:8080/integrations/discord", host: "mf-hook.example.test", channelIds: [FAMILY], noticeChannelIds: [], enabled: true,
};

function message(overrides: Partial<DiscordChatMessage> = {}): DiscordChatMessage {
  return {
    messageId: "423456789012345678", guildId: "523456789012345678", channelId: THREAD, parentId: FAMILY,
    authorId: "623456789012345678", authorDisplayName: "neco", text: "今日の連絡帳なに書こう", mentionsBot: true,
    sentAt: new Date("2026-10-18T07:00:00.000Z"), ...overrides,
  };
}

const route = { kind: "relay" as const, target, channelId: FAMILY, threadId: THREAD };

function okResponse(json: unknown, status = 200): RelayOutcome {
  return { kind: "response", status, body: Buffer.from(JSON.stringify(json)), contentType: "application/json" };
}

function service(send: (input: RelayInput) => Promise<RelayOutcome>, token: string | null = TOKEN) {
  return createDiscordChatRelayService({ targets: () => [target], relayToken: () => token, send, ledger: createMessageLedger() });
}

describe("createDiscordChatRelayService.forward", () => {
  it("取り決めの本文とヘッダで転送し、返事を返す", async () => {
    const send = vi.fn(async (_input: RelayInput) => okResponse({ replies: [{ text: "どうぞ" }, { text: "例: 公園" }] }));
    const result = await service(send).forward(message(), route);
    expect(result).toEqual({ kind: "replied", target: "mf", replies: [{ text: "どうぞ" }, { text: "例: 公園" }] });
    const input = send.mock.calls[0]![0];
    expect(input.url).toBe(target.url);
    const body = JSON.parse(Buffer.from(input.body).toString("utf8"));
    expect(body).toEqual({
      version: 1, messageId: "423456789012345678", channelId: FAMILY, threadId: THREAD, guildId: "523456789012345678",
      author: { id: "623456789012345678", displayName: "neco" }, text: "今日の連絡帳なに書こう", mentionsBot: true,
      sentAt: "2026-10-18T07:00:00.000Z",
    });
    expect(input.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-concordia-discord-target": "mf",
      "content-length": String(input.body.byteLength),
      host: "mf-hook.example.test",
    });
  });

  it("同じ messageId は 1 回だけ転送する (結果不明でも再送しない)", async () => {
    const send = vi.fn(async (): Promise<RelayOutcome> => ({ kind: "unreachable", reason: "timeout" }));
    const relay = service(send);
    expect(await relay.forward(message(), route)).toEqual({ kind: "failed", target: "mf", failure: "timeout", status: null });
    expect(await relay.forward(message(), route)).toEqual({ kind: "duplicate", target: "mf" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("中継トークンが未設定なら転送しない", async () => {
    const send = vi.fn(async () => okResponse({ replies: [] }));
    expect(await service(send, null).forward(message(), route))
      .toEqual({ kind: "failed", target: "mf", failure: "relay_token_missing", status: null });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["2xx 以外", okResponse({ error: "relay_token_rejected" }, 401), { failure: "upstream_status", status: 401 }],
    ["接続失敗", { kind: "unreachable", reason: "connect" } as RelayOutcome, { failure: "connect", status: null }],
    ["形の違う JSON", okResponse({ replies: [{ text: "" }] }), { failure: "invalid_response", status: 200 }],
  ])("%s は投稿する返事を返さず失敗種別だけを返す", async (_label, outcome, expected) => {
    const result = await service(async () => outcome).forward(message(), route);
    expect(result).toEqual({ kind: "failed", target: "mf", ...expected });
  });

  it("route は設定を毎回読んで振り分ける", () => {
    const targets = vi.fn(() => [target]);
    const relay = createDiscordChatRelayService({ targets, relayToken: () => TOKEN, send: vi.fn() });
    expect(relay.route({ channelId: FAMILY, parentId: null }, () => false).kind).toBe("relay");
    expect(relay.route({ channelId: FAMILY, parentId: null }, () => false).kind).toBe("relay");
    expect(targets).toHaveBeenCalledTimes(2);
  });
});

describe("buildDiscordRelayHeaders", () => {
  it("host が無ければ Host を付けない", () => {
    expect(buildDiscordRelayHeaders({ name: "mf", host: null }, TOKEN, 10)).toEqual({
      "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-concordia-discord-target": "mf", "content-length": "10",
    });
  });
});

describe("parseDiscordRelayReplies", () => {
  const parse = (value: unknown) => parseDiscordRelayReplies(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));

  it("0〜5 件・各 1〜2000 字の text だけを受け付ける", () => {
    expect(parse({ replies: [] })).toEqual([]);
    expect(parse({ replies: [{ text: "a".repeat(2000) }] })).toEqual([{ text: "a".repeat(2000) }]);
    expect(parse({ replies: Array.from({ length: 5 }, () => ({ text: "x" })) })).toHaveLength(5);
  });

  it.each([
    ["JSON でない", "nope"],
    ["replies 欠落", {}],
    ["6 件", { replies: Array.from({ length: 6 }, () => ({ text: "x" })) }],
    ["空の text", { replies: [{ text: "" }] }],
    ["2001 字", { replies: [{ text: "a".repeat(2001) }] }],
    ["text が文字列でない", { replies: [{ text: 1 }] }],
  ])("%s は null", (_label, value) => {
    expect(parse(value)).toBeNull();
  });
});

describe("中継トークンの置き場所", () => {
  it("discord_chat_relay.<target>.relay_token に置き、状態は真偽値だけを返す", () => {
    const values = new Map<string, string>();
    const store = {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => { values.set(key, value); },
      delete: (key: string) => { values.delete(key); },
    };
    expect(describeDiscordChatRelaySecrets(store, "mf")).toEqual({ relay_token_set: false });
    setDiscordChatRelaySecret(store, "mf", "relay_token", TOKEN);
    expect([...values.keys()]).toEqual(["discord_chat_relay.mf.relay_token"]);
    expect(readDiscordChatRelayToken(store, "mf")).toBe(TOKEN);
    expect(describeDiscordChatRelaySecrets(store, "mf")).toEqual({ relay_token_set: true });
  });

  it("復号できない値は未設定と同じに扱う", () => {
    const store = { get: () => { throw new Error("decrypt failed"); }, set: () => {}, delete: () => {} };
    expect(readDiscordChatRelayToken(store, "mf")).toBeNull();
  });
});

describe("createMessageLedger", () => {
  it("上限を超えたら古いものから忘れる", () => {
    const ledger = createMessageLedger(2);
    expect(ledger.claim("a")).toBe(true);
    expect(ledger.claim("b")).toBe(true);
    expect(ledger.claim("a")).toBe(false);
    expect(ledger.claim("c")).toBe(true);
    expect(ledger.claim("a")).toBe(true);
  });
});
