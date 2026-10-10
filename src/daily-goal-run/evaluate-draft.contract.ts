/** @implements spec/feature/daily-goal-run.md — 2. 欠けていれば登録せず定義してもらう (CC-DG-INV-01 / CC-DG-INV-09) */
/** A draft completes only with a resolved project, a goal text and at least one acceptance item; otherwise it names exactly the missing fields. */
function present(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const extracted = args[0] as { project?: unknown; goalText?: unknown; acceptance?: unknown } | null;
    const resolved = args[1] as { project?: unknown } | null;
    const r = result as { status?: unknown; missing?: unknown } | null;
    if (!r) return false;
    const missing: string[] = [];
    if (!present(extracted?.project) || !resolved) missing.push("project");
    if (!present(extracted?.goalText)) missing.push("goal");
    if (!(Array.isArray(extracted?.acceptance) && extracted!.acceptance.some(present))) missing.push("acceptance");
    if (missing.length === 0) return r.status === "complete";
    return r.status === "missing" && JSON.stringify(r.missing) === JSON.stringify(missing);
  },
};
