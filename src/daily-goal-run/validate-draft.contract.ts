/** @implements spec/feature/daily-goal-run.md — 2. ゴールを確定する (欠けた項目は確定せず聞き返す) */
/**
 * A draft is accepted only when every required field is present: project, goal text,
 * at least one acceptance item and Actio task, and all four permissions given explicitly.
 * A rejected draft names every missing field and nothing else.
 */
const PERMISSIONS = ["merge", "test", "service", "deploy"] as const;

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function listed(value: unknown): boolean {
  return Array.isArray(value) && value.some(present);
}

function contentGaps(draft: Record<string, unknown>): string[] {
  const gaps: string[] = [];
  if (!present(draft.project) || !present(draft.repoPath)) gaps.push("project");
  if (!present(draft.goalText)) gaps.push("goalText");
  if (!listed(draft.acceptance)) gaps.push("acceptance");
  if (!listed(draft.actioTaskIds)) gaps.push("actioTaskIds");
  return gaps;
}

function permissionGaps(permissions: unknown): string[] {
  const values = (permissions ?? {}) as Record<string, unknown>;
  return PERMISSIONS.filter((key) => typeof values[key] !== "boolean");
}

function matches(result: { ok?: unknown; missing?: unknown }, expected: string[]): boolean {
  if (expected.length === 0) return result.ok === true;
  return result.ok === false && JSON.stringify(result.missing) === JSON.stringify(expected);
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const draft = (args[0] ?? {}) as Record<string, unknown>;
    const r = result as { ok?: unknown; missing?: unknown } | null;
    if (!r || typeof r.ok !== "boolean") return false;
    return matches(r, [...contentGaps(draft), ...permissionGaps(draft.permissions)]);
  },
};
