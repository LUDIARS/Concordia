/** @implements SPEC-BOUNTY-TRIAGE */
/**
 * C-2: an accepted triage result only carries enumerated values within the length limits; a
 * duplicate points at an existing root report (not itself a duplicate) in the same project.
 */
const VERDICTS = ["accepted", "duplicate", "rejected", "needs_info"];
const SEVERITIES = ["s1", "s2", "s3", "s4", null];

type Row = { id: string; project_code: string | null; duplicate_of: string | null };

export default {
  post(
    result: unknown,
    input: { report?: { id?: string }; find?: (id: string) => Row | null; registeredProjects?: readonly string[] } | undefined,
  ): boolean {
    if (!result || typeof result !== "object") return false;
    const outcome = result as { ok?: unknown; value?: Record<string, unknown>; errors?: unknown };
    if (outcome.ok !== true) return Array.isArray(outcome.errors) && outcome.errors.length > 0;
    const value = outcome.value ?? {};
    if (!VERDICTS.includes(String(value.verdict))) return false;
    if (!SEVERITIES.includes(value.severity as string | null)) return false;
    if (typeof value.publicTitle === "string" && value.publicTitle.length > 120) return false;
    if (typeof value.publicSummary === "string" && value.publicSummary.length > 1000) return false;
    if (value.project !== null && typeof value.project === "string"
      && input?.registeredProjects && !input.registeredProjects.includes(value.project)) return false;
    if (value.verdict !== "duplicate") return value.duplicateOf === null;
    if (typeof value.duplicateOf !== "string" || value.duplicateOf === input?.report?.id) return false;
    const root = input?.find?.(value.duplicateOf) ?? null;
    return !!root && root.duplicate_of === null && root.project_code === value.project;
  },
};
