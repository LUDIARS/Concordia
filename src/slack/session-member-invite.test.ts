import { describe, it, expect, vi } from "vitest";
import { SlackAlwaysInviter, normalizeSlackAlwaysInvite, parseSlackAlwaysInvite } from "./session-member-invite.js";
import type { SlackInviteClient } from "./session-starter-invite.js";

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

function makeInviter(members: string[], impl?: SlackInviteClient["conversations"]["invite"]) {
  const invite = vi.fn(impl ?? (async () => ({})));
  const log = { info: vi.fn(), warn: vi.fn() };
  return { inviter: new SlackAlwaysInviter({ client: { conversations: { invite } }, resolveMembers: () => members, log }), invite, log };
}

describe("SlackAlwaysInviter", () => {
  it("常時招待メンバーを 1 人ずつ、 session ごとに 1 回だけ招待する", async () => {
    const { inviter, invite } = makeInviter(["U9B7AE3SQ", "UBBBB2222"]);
    await inviter.invite("s1", "C1");
    await inviter.invite("s1", "C1");
    expect(invite.mock.calls.map(([args]) => args)).toEqual([
      { channel: "C1", users: "U9B7AE3SQ" },
      { channel: "C1", users: "UBBBB2222" },
    ]);
    await inviter.invite("s2", "C2");
    expect(invite).toHaveBeenCalledTimes(4);
  });

  it("1 人の失敗で他のメンバーを止めず、 失敗した人は次の契機で再試行する", async () => {
    let fail = true;
    const { inviter, invite, log } = makeInviter(["UAAAA1111", "UBBBB2222"], async ({ users }) => {
      if (users === "UAAAA1111" && fail) throw slackError("ratelimited");
      return {};
    });
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    fail = false;
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(3);
    expect(invite).toHaveBeenLastCalledWith({ channel: "C1", users: "UAAAA1111" });
  });

  it("already_in_channel は招待済み、 forget で記録を捨てる", async () => {
    const { inviter, invite, log } = makeInviter(["U9B7AE3SQ"], async () => { throw slackError("already_in_channel"); });
    await inviter.invite("s1", "C1");
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    inviter.forget("s1");
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(2);
  });

  it("一覧を正規化し、 壊れた保存値は空扱いにする", () => {
    expect(normalizeSlackAlwaysInvite([" U9B7AE3SQ", "U9B7AE3SQ", "W0123ABC"])).toEqual(["U9B7AE3SQ", "W0123ABC"]);
    expect(() => normalizeSlackAlwaysInvite(["111111"])).toThrow();
    expect(parseSlackAlwaysInvite("not json")).toEqual([]);
    expect(parseSlackAlwaysInvite('["U9B7AE3SQ",3]')).toEqual(["U9B7AE3SQ"]);
  });
});
