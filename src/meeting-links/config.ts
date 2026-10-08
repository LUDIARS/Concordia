export interface MeetingLinkConfig { guildId: string; audience: string }

/** Disabled is explicit; an enabled but incomplete trust boundary must fail closed. */
export function meetingLinkConfig(env: NodeJS.ProcessEnv = process.env): MeetingLinkConfig | null {
  const enabled = env.CONCORDIA_MEETING_LINK_ENABLED;
  if (enabled === undefined || enabled === "false") return null;
  if (enabled !== "true") throw new Error("CONCORDIA_MEETING_LINK_ENABLED must be true or false");
  const guildId = env.CONCORDIA_MEETING_LINK_GUILD_ID?.trim();
  const target = env.CONCORDIA_MEETING_LINK_PUBLIC_URL?.trim();
  if (!guildId || !/^\d{17,20}$/.test(guildId) || !target) throw new Error("Meeting links require a guild and public origin");
  const url = new URL(target);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Meeting link public URL must be an HTTPS or loopback HTTP origin");
  }
  return { guildId, audience: url.origin };
}
