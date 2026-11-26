/** @implements spec/feature/glab-unity-hub.md — C-5 checkPayload (guh-C-5) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [method, payload] = args as [string, Record<string, unknown> | null];
    const check = result as { ok: boolean };
    const p = payload ?? {};
    if (method === "discord.messages.list" && typeof p.limit === "number" && p.limit > 50) return check.ok === false;
    if (method === "discord.messages.post" && typeof p.content === "string" && p.content.length > 2000) return check.ok === false;
    if (method === "spec.review" && p.decision !== "accept" && p.decision !== "reject") return check.ok === false;
    return typeof check.ok === "boolean";
  },
};
