/** @implements SPEC-BOUNTY-REPORTER */
/**
 * C-5: a session report's recipient is the session's requester. A session whose requester
 * cannot be identified has no recipient (spec/feature/bug-bounty.md §4, CC-BOUNTY-INV-05).
 */
const DISCORD_USER_ID = /^\d{5,32}$/;

export default {
  post(result: unknown, input: { requesterDiscordUserId?: unknown; companyId?: unknown } | undefined): boolean {
    const requester = typeof input?.requesterDiscordUserId === "string" ? input.requesterDiscordUserId.trim() : "";
    if (!DISCORD_USER_ID.test(requester)) return result === null;
    if (!result || typeof result !== "object") return false;
    const recipient = result as { companyId?: unknown; platform?: unknown; platformUserId?: unknown };
    return recipient.platform === "discord"
      && recipient.platformUserId === requester
      && recipient.companyId === (input?.companyId ?? null);
  },
};
