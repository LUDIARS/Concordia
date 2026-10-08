import { it, expect, vi } from "vitest";
import { redeemMeetingLink } from "./redeem.js";
const proof = { meetingId: "m", guildId: "g", discordUserId: "u", displayName: "name", audience: "https://example.test" };
it.each([null, { id: "u", bot: true, pending: false }, { id: "u", bot: false, pending: true }, { id: "other", bot: false, pending: false }])("denies ineligible membership before consumption: %j", async member => {
  const consume = vi.fn();
  expect(await redeemMeetingLink({ code: "c", meetingId: "m", audience: proof.audience }, {
    config: { guildId: "g", audience: proof.audience }, store: { peek: () => proof, consume }, member: async () => member,
  })).toBeNull();
  expect(consume).not.toHaveBeenCalled();
});
it("checks membership before atomic consumption, including a losing concurrent consumer", async () => {
  const consume = vi.fn().mockReturnValueOnce(proof).mockReturnValue(null);
  const member = vi.fn(async () => ({ id: "u", bot: false, pending: false }));
  const deps = { config: { guildId: "g", audience: proof.audience }, store: { peek: () => proof, consume }, member };
  const request = { code: "c", meetingId: "m", audience: proof.audience };
  expect(await redeemMeetingLink(request, deps)).toEqual(proof);
  expect(await redeemMeetingLink(request, deps)).toBeNull();
  expect(member.mock.invocationCallOrder[0]).toBeLessThan(consume.mock.invocationCallOrder[0]!);
});
