/** @implements spec/feature/glab-unity-hub.md — C-1 decideIssue (guh-C-1) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [input] = args as [{ guildId: string | null; glabGuildId: string; activeTokenCount: number }];
    const verdict = result as { ok: boolean; reason?: string };
    if (!input.guildId || input.guildId !== input.glabGuildId) return verdict.ok === false && verdict.reason === "wrong_guild";
    if (input.activeTokenCount >= 3) return verdict.ok === false && verdict.reason === "limit_reached";
    return verdict.ok === true;
  },
};
