import type { MeetingLinkConfig } from "./config.js";
import type { MeetingLinkStore } from "./store.js";
import { eligibleMeetingMember } from "./policy.js";

export async function redeemMeetingLink(input: { code: string; meetingId: string; audience: string }, deps: {
  config: MeetingLinkConfig; store: Pick<MeetingLinkStore, "peek" | "consume">;
  member: (userId: string) => Promise<{ id: string; bot: boolean; pending: boolean } | null>;
}) {
  const proof = deps.store.peek(input.code, input.meetingId, input.audience);
  if (!proof || proof.guildId !== deps.config.guildId || input.audience !== deps.config.audience) return null;
  const member = await deps.member(proof.discordUserId);
  if (!member || !eligibleMeetingMember(member, proof.discordUserId)) return null;
  return deps.store.consume(input.code, input.meetingId, input.audience);
}
