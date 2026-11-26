/** @implements spec/feature/glab-unity-hub.md — C-7 checkReport (guh-C-7) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [value, allowed] = args as [Record<string, unknown> | null, readonly string[]];
    const check = result as { ok: boolean; code?: string };
    const repo = typeof value?.repo === "string" ? value.repo.trim().toLowerCase() : null;
    const listed = repo !== null && allowed.some((entry) => entry.trim().toLowerCase() === repo);
    if (check.ok) return listed;
    return check.code === "forbidden" || check.code === "invalid_request";
  },
};
