import { describe, it, expect } from "vitest";
import { normalizeSlackMemberMap, parseSlackMemberMap, resolveSlackInvitee } from "./member-map.js";

const MAP = [{ discord_user_id: "111111111111", slack_user_id: "UAAAA1111" }];

describe("normalizeSlackMemberMap", () => {
  it("空白を除き、 Discord ID の重複は後勝ちにする", () => {
    expect(normalizeSlackMemberMap([
      { discord_user_id: " 111111111111 ", slack_user_id: "UAAAA1111" },
      { discord_user_id: "111111111111", slack_user_id: " WBBBB2222 " },
    ])).toEqual([{ discord_user_id: "111111111111", slack_user_id: "WBBBB2222" }]);
  });

  it("形式違反の ID は Error", () => {
    expect(() => normalizeSlackMemberMap([{ discord_user_id: "abc", slack_user_id: "UAAAA1111" }])).toThrow(/Discord/);
    expect(() => normalizeSlackMemberMap([{ discord_user_id: "111111111111", slack_user_id: "C0123" }])).toThrow(/Slack/);
  });
});

describe("parseSlackMemberMap", () => {
  it("保存済み JSON を読み、 壊れた値は空にする", () => {
    expect(parseSlackMemberMap(JSON.stringify(MAP))).toEqual(MAP);
    expect(parseSlackMemberMap(null)).toEqual([]);
    expect(parseSlackMemberMap("{not json")).toEqual([]);
    expect(parseSlackMemberMap(JSON.stringify({ a: 1 }))).toEqual([]);
  });
});

describe("resolveSlackInvitee", () => {
  it.each(["UCCCC3333", "WBBBB2222", "U12", `W${"A".repeat(31)}`])("有効な Slack ID %s はそのまま返す", (userId) => {
    expect(resolveSlackInvitee({ platform: "slack", userId }, MAP)).toBe(userId);
  });

  it.each([
    "UCCCC3333,WBBBB2222", "", "C0123", "ucccc3333", "Uab", "U1",
    `U${"A".repeat(32)}`, " UCCCC3333", "UCCCC3333 ", "UCCCC3333\n", "UCC\t3333",
  ])("形式違反の Slack ID %j は招待しない", (userId) => {
    expect(resolveSlackInvitee({ platform: "slack", userId }, MAP)).toBeNull();
  });

  it("Slack 起動はそのまま、 Discord 起動は対応表で引く", () => {
    expect(resolveSlackInvitee({ platform: "slack", userId: "UCCCC3333" }, MAP)).toBe("UCCCC3333");
    expect(resolveSlackInvitee({ platform: "discord", userId: "111111111111" }, MAP)).toBe("UAAAA1111");
  });

  it("対応なし・起動者不明は null", () => {
    expect(resolveSlackInvitee({ platform: "discord", userId: "999999999999" }, MAP)).toBeNull();
    expect(resolveSlackInvitee(null, MAP)).toBeNull();
  });
});
