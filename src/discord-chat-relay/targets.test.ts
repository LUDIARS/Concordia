// @implements spec/feature/discord-chat-relay.md — 転送先の登録 / 受信
import { describe, expect, it } from "vitest";
import { routeDiscordChatMessage } from "./routing.js";
import {
  parseDiscordChatRelayTargets,
  readDiscordChatRelayTargets,
  validateDiscordChatRelayTargetEntries,
  type DiscordChatRelayTarget,
} from "./targets.js";

const FAMILY = "123456789012345678";
const OTHER = "223456789012345678";
const THREAD = "323456789012345678";

const mf = JSON.stringify({ name: "mf", url: "http://192.0.2.10:8080/integrations/discord", host: "mf-hook.example.test", channelIds: [FAMILY], enabled: true });
const off = JSON.stringify({ name: "off", url: "https://off.example.test/hook", channelIds: [OTHER], enabled: false });

describe("parseDiscordChatRelayTargets", () => {
  it("正しい項目を転送先として読む (host は任意)", () => {
    expect(parseDiscordChatRelayTargets([mf, off])).toEqual({
      targets: [
        { name: "mf", url: "http://192.0.2.10:8080/integrations/discord", host: "mf-hook.example.test", channelIds: [FAMILY], enabled: true },
        { name: "off", url: "https://off.example.test/hook", host: null, channelIds: [OTHER], enabled: false },
      ],
      errors: [],
    });
  });

  it.each([
    ["JSON でない", "mf http://192.0.2.10/"],
    ["名前に大文字", JSON.stringify({ name: "Mf", url: "http://192.0.2.10/", channelIds: [FAMILY], enabled: true })],
    ["http/https 以外", JSON.stringify({ name: "mf", url: "ftp://192.0.2.10/", channelIds: [FAMILY], enabled: true })],
    ["資格情報入り URL", JSON.stringify({ name: "mf", url: "http://u:p@192.0.2.10/", channelIds: [FAMILY], enabled: true })],
    ["host にパス", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", host: "a.example.test/x", channelIds: [FAMILY], enabled: true })],
    ["channelIds 欠落", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", enabled: true })],
    ["channelIds が空", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", channelIds: [], enabled: true })],
    ["channelIds が数値", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", channelIds: [123456789012345678], enabled: true })],
    ["channelIds が snowflake でない", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", channelIds: ["family"], enabled: true })],
    ["channelIds の重複", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", channelIds: [FAMILY, FAMILY], enabled: true })],
    ["enabled 欠落", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", channelIds: [FAMILY] })],
    ["未知のキー", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", channelIds: [FAMILY], enabled: true, token: "x" })],
  ])("%s の項目は採用せず理由を返す", (_label, entry) => {
    const parsed = parseDiscordChatRelayTargets([entry]);
    expect(parsed.targets).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatch(/^1 件目: /);
  });

  it("重複名は 2 件目を採用しない", () => {
    const again = JSON.stringify({ name: "mf", url: "http://192.0.2.11/", channelIds: [OTHER], enabled: true });
    const parsed = parseDiscordChatRelayTargets([mf, again]);
    expect(parsed.targets.map((target) => target.name)).toEqual(["mf"]);
    expect(parsed.errors).toEqual(['2 件目: name "mf" が重複しています']);
  });

  it("他の target に割り当て済みのチャンネルを含む行は採用しない (同じ発言を 2 か所へ送らない)", () => {
    const clash = JSON.stringify({ name: "other", url: "http://192.0.2.11/", channelIds: [OTHER, FAMILY], enabled: true });
    const parsed = parseDiscordChatRelayTargets([mf, clash]);
    expect(parsed.targets.map((target) => target.name)).toEqual(["mf"]);
    expect(parsed.errors).toEqual([`2 件目: channelId ${FAMILY} は "mf" に割り当て済みです`]);
  });

  it("PUT の検証は 1 件でも壊れていれば理由を返す", () => {
    expect(validateDiscordChatRelayTargetEntries([mf])).toBeNull();
    expect(validateDiscordChatRelayTargetEntries([mf, "x"])).toMatch(/2 件目/);
  });

  it("schema_meta の生値を読む (壊れていれば転送先なし)", () => {
    expect(readDiscordChatRelayTargets(JSON.stringify([mf])).map((target) => target.name)).toEqual(["mf"]);
    expect(readDiscordChatRelayTargets(null)).toEqual([]);
    expect(readDiscordChatRelayTargets("{")).toEqual([]);
    expect(readDiscordChatRelayTargets(JSON.stringify({ a: 1 }))).toEqual([]);
  });
});

describe("routeDiscordChatMessage", () => {
  const targets: DiscordChatRelayTarget[] = parseDiscordChatRelayTargets([mf, off]).targets;
  const noSession = () => false;

  it("登録チャンネルの発言は threadId なしで中継先に振る", () => {
    expect(routeDiscordChatMessage(targets, { channelId: FAMILY, parentId: null }, noSession))
      .toMatchObject({ kind: "relay", target: { name: "mf" }, channelId: FAMILY, threadId: null });
  });

  it("登録チャンネルの子スレッドの発言は親チャンネルとスレッドを分けて振る", () => {
    expect(routeDiscordChatMessage(targets, { channelId: THREAD, parentId: FAMILY }, noSession))
      .toMatchObject({ kind: "relay", target: { name: "mf" }, channelId: FAMILY, threadId: THREAD });
  });

  it("未登録・無効な target のチャンネルは中継しない", () => {
    expect(routeDiscordChatMessage(targets, { channelId: "999999999999999999", parentId: null }, noSession)).toEqual({ kind: "none" });
    expect(routeDiscordChatMessage(targets, { channelId: OTHER, parentId: null }, noSession)).toEqual({ kind: "none" });
  });

  it("セッション中継に割り当て済みなら conflict (スレッド自身でも親でも)", () => {
    expect(routeDiscordChatMessage(targets, { channelId: FAMILY, parentId: null }, (id) => id === FAMILY))
      .toMatchObject({ kind: "conflict", target: { name: "mf" } });
    expect(routeDiscordChatMessage(targets, { channelId: THREAD, parentId: FAMILY }, (id) => id === THREAD))
      .toMatchObject({ kind: "conflict", target: { name: "mf" } });
  });
});
