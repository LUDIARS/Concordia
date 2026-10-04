/** @implements SPEC-BOUNTY-INTAKE */
/**
 * C-4: an unregistered code and a code outside the company's related projects are refused;
 * an unspecified code passes as "target unknown" (spec/feature/bug-bounty.md §3, CC-INV-02).
 */
function sameName(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string"
    && left.trim().toLowerCase() === right.trim().toLowerCase();
}

export default {
  post(
    result: unknown,
    input: {
      code?: unknown;
      registered?: ReadonlyArray<{ code: string; project: string }>;
      companyProjects?: readonly string[] | null;
    } | undefined,
  ): boolean {
    if (!result || typeof result !== "object") return false;
    const outcome = result as { ok?: unknown; project?: unknown; denial?: unknown };
    const code = typeof input?.code === "string" ? input.code.trim() : "";
    if (!code) return outcome.ok === true && outcome.project === null;
    if (outcome.ok !== true) {
      return outcome.denial === "unknown_project" || outcome.denial === "project_outside_company_scope";
    }
    const accepted = outcome.project as { code?: unknown; project?: unknown } | null;
    if (!accepted) return false;
    const registered = (input?.registered ?? []).some((row) => row.code === accepted.code);
    const scope = input?.companyProjects ?? null;
    const inScope = scope === null
      || scope.some((name) => sameName(name, accepted.code) || sameName(name, accepted.project));
    return registered && inScope;
  },
};
