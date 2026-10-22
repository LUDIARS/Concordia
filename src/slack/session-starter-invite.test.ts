import { describe, it, expect, vi } from "vitest";
import type { Requester } from "../control/requester.js";
import { SlackSessionStarterInviter, type SlackInviteClient } from "./session-starter-invite.js";

const MAP = [{ discord_user_id: "111111111111", slack_user_id: "UAAAA1111" }];
const DISCORD_STARTER: Requester = { platform: "discord", userId: "111111111111" };

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

function makeInviter(opts: {
  invite?: SlackInviteClient["conversations"]["invite"];
  starter?: Requester | null;
}) {
  const invite = vi.fn(opts.invite ?? (async () => ({})));
  const log = { info: vi.fn(), warn: vi.fn() };
  const inviter = new SlackSessionStarterInviter({
    client: { conversations: { invite } },
    resolveStarter: () => opts.starter ?? null,
    resolveMemberMap: () => MAP,
    log,
  });
  return { inviter, invite, log };
}

describe("SlackSessionStarterInviter", () => {
  it("Discord 起動者を対応表で引いて 1 回だけ招待する", async () => {
    const { inviter, invite } = makeInviter({ starter: DISCORD_STARTER });
    await inviter.invite("s1", "C1");
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(1);
    expect(invite).toHaveBeenCalledWith({ channel: "C1", users: "UAAAA1111" });
  });

  it("DB に起動者が無いときは今届いた inject の入力者を使う", async () => {
    const { inviter, invite } = makeInviter({ starter: null });
    await inviter.invite("s1", "C1", { platform: "slack", userId: "UCCCC3333" });
    expect(invite).toHaveBeenCalledWith({ channel: "C1", users: "UCCCC3333" });
  });

  it("DB の起動者を hint より優先する (後から指示した人は招待しない)", async () => {
    const { inviter, invite } = makeInviter({ starter: DISCORD_STARTER });
    await inviter.invite("s1", "C1", { platform: "slack", userId: "UCCCC3333" });
    expect(invite).toHaveBeenCalledWith({ channel: "C1", users: "UAAAA1111" });
  });

  it("起動者不明・対応なしは招待せず、 後の契機で再試行できる", async () => {
    const { inviter, invite } = makeInviter({ starter: null });
    await inviter.invite("s1", "C1");
    await inviter.invite("s1", "C1", { platform: "discord", userId: "999999999999" });
    expect(invite).not.toHaveBeenCalled();
    await inviter.invite("s1", "C1", DISCORD_STARTER);
    expect(invite).toHaveBeenCalledTimes(1);
  });

  it("already_in_channel は招待済みとして扱う", async () => {
    const { inviter, invite, log } = makeInviter({
      starter: DISCORD_STARTER,
      invite: async () => { throw slackError("already_in_channel"); },
    });
    await inviter.invite("s1", "C1");
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("その他の失敗は warn のみで throw せず、 次の契機で再試行する", async () => {
    const { inviter, invite, log } = makeInviter({
      starter: DISCORD_STARTER,
      invite: async () => { throw slackError("missing_scope"); },
    });
    await expect(inviter.invite("s1", "C1")).resolves.toBeUndefined();
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));
  });

  it("forget 後は再び招待する", async () => {
    const { inviter, invite } = makeInviter({ starter: DISCORD_STARTER });
    await inviter.invite("s1", "C1");
    inviter.forget("s1");
    await inviter.invite("s1", "C1");
    expect(invite).toHaveBeenCalledTimes(2);
  });
});
