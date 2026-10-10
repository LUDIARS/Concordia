/** @implements spec/feature/daily-goal-run.md — CC-DG-INV-01 / CC-DG-INV-04 (本人の確定と許可範囲の上限) */
/**
 * Bots and webhooks never confirm. Allowing merge or deploy requires a manager or higher;
 * otherwise any registered or unregistered human may confirm.
 */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const actor = (args[0] ?? {}) as { isBot?: unknown; isWebhook?: unknown; userId?: unknown; role?: unknown };
    const permissions = (args[1] ?? {}) as { merge?: unknown; deploy?: unknown };
    const r = result as { ok?: unknown } | null;
    if (!r || typeof r.ok !== "boolean") return false;
    const human = actor.isBot !== true && actor.isWebhook !== true && typeof actor.userId === "string" && actor.userId.trim() !== "";
    const manager = actor.role === "manager" || actor.role === "executive";
    const needsManager = permissions.merge === true || permissions.deploy === true;
    return r.ok === (human && (!needsManager || manager));
  },
};
