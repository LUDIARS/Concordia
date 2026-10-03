/** @implements SPEC-CONSULT-LOG */
/**
 * C-2: the consult log lives at <role folder>/<Discord ID or _unknown>/logs/<JST date>_<session id>.md
 * and never resolves outside the role folder.
 */
export default {
  post(result: unknown, input: unknown): boolean {
    if (typeof result !== "string" || !input || typeof input !== "object") return false;
    const { roleWorkspace, requesterDiscordUserId, sessionId } = input as {
      roleWorkspace?: unknown; requesterDiscordUserId?: unknown; sessionId?: unknown;
    };
    if (typeof roleWorkspace !== "string" || typeof sessionId !== "string") return false;
    const slash = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
    const owner = typeof requesterDiscordUserId === "string" && /^\d{5,32}$/.test(requesterDiscordUserId)
      ? requesterDiscordUserId : "_unknown";
    const prefix = `${slash(roleWorkspace)}/${owner}/logs/`;
    const path = slash(result);
    if (!path.startsWith(prefix)) return false;
    return /^\d{4}-\d{2}-\d{2}_[^/\\]+\.md$/.test(path.slice(prefix.length));
  },
};
