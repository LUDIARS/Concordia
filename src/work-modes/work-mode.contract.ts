/** @implements spec/feature/work-modes.md — CC-WM-INV-01 (1 セッションは同時に 1 つの方式) */
/**
 * Recording a mode succeeds only when no mode is active or the same mode and reference is
 * already active; the resulting metadata then carries exactly that mode.
 */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const metadata = args[0] as string | null | undefined;
    const next = args[1] as { mode: string; ref?: string | null } | undefined;
    const r = result as { ok?: unknown; metadata?: unknown } | null;
    if (!r || !next || typeof r.ok !== "boolean") return false;
    let active: { mode?: unknown; ref?: unknown } | null = null;
    try {
      const parsed = metadata ? JSON.parse(metadata) as { work_mode?: { mode?: unknown; ref?: unknown } | null } : {};
      active = parsed && typeof parsed.work_mode === "object" && parsed.work_mode ? parsed.work_mode : null;
    } catch { active = null; }
    const ref = next.ref ?? null;
    const known = !!active && typeof active.mode === "string";
    const conflicting = known && (active!.mode !== next.mode || (active!.ref ?? null) !== ref);
    if (conflicting) return r.ok === false;
    if (r.ok !== true || typeof r.metadata !== "string") return false;
    const after = JSON.parse(r.metadata) as { work_mode?: { mode?: unknown; ref?: unknown } };
    return after.work_mode?.mode === next.mode && (after.work_mode?.ref ?? null) === ref;
  },
};
