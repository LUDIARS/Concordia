export interface MeetingLinkIdentity {
  meetingId: string; guildId: string; discordUserId: string; displayName: string; audience: string;
}
export const MEETING_LINK_LIFETIME_MS = 5 * 60 * 1000;
export function validMeetingIdentity(identity: MeetingLinkIdentity): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.meetingId)
    && /^\d{17,20}$/.test(identity.guildId) && /^\d{17,20}$/.test(identity.discordUserId)
    && identity.displayName.trim().length > 0 && identity.displayName.length <= 80;
}
export function canIssueMeetingLink(active: number, recent: number): boolean {
  return active < 10000 && recent < 5;
}
export function eligibleMeetingMember(member: { id: string; bot: boolean; pending: boolean }, expectedId: string): boolean {
  return member.id === expectedId && !member.bot && !member.pending;
}
