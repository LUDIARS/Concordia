import { describe, expect, it } from "vitest";
import contract from "./triage-result.contract.js";
import { resolveDuplicateRoot, validateBountyTriageResult, type BountyTriageLookupRow } from "./triage-result.js";

const rows = new Map<string, BountyTriageLookupRow>([
  ["br_root", { id: "br_root", project_code: "Cc", duplicate_of: null }],
  ["br_dup", { id: "br_dup", project_code: "Cc", duplicate_of: "br_root" }],
  ["br_other", { id: "br_other", project_code: "At", duplicate_of: null }],
  ["br_loop1", { id: "br_loop1", project_code: "Cc", duplicate_of: "br_loop2" }],
  ["br_loop2", { id: "br_loop2", project_code: "Cc", duplicate_of: "br_loop1" }],
]);
const find = (id: string) => rows.get(id) ?? null;
const base = {
  report: { id: "br_new", project_code: "Cc" as string | null },
  find,
  registeredProjects: ["Cc", "At"],
  companyProjects: null as readonly string[] | null,
};
const accepted = { verdict: "accepted", severity: "s2", public_title: "スレッドが作られない", reason: "再現した", hotfix_eligible: true };

describe("validateBountyTriageResult (bug-bounty.md §5)", () => {
  it("accepts a well-formed result and keeps sensitive by default", () => {
    const input = { ...base, raw: accepted };
    const result = validateBountyTriageResult(input);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ verdict: "accepted", severity: "s2", sensitive: true, hotfixEligible: true, project: "Cc" }),
    });
    expect(contract.post(result, input as unknown as Parameters<typeof contract.post>[1])).toBe(true);
  });

  it("refuses values outside the enumerations, missing reasons and oversized titles without saving", () => {
    for (const raw of [
      { ...accepted, verdict: "approved" },
      { ...accepted, severity: "s9" },
      { ...accepted, reason: "" },
      { ...accepted, public_title: "x".repeat(121) },
      { ...accepted, sensitive: "yes" },
    ]) {
      const result = validateBountyTriageResult({ ...base, raw });
      expect(result.ok).toBe(false);
      expect(contract.post(result, { ...base, raw } as unknown as Parameters<typeof contract.post>[1])).toBe(true);
    }
  });

  it("re-roots a duplicate to the first report and refuses missing, cross-project or cyclic targets", () => {
    const ok = validateBountyTriageResult({ ...base, raw: { verdict: "duplicate", duplicate_of: "br_dup", reason: "同じ" } });
    expect(ok).toMatchObject({ ok: true, value: { duplicateOf: "br_root", hotfixEligible: false } });
    expect(contract.post(ok, base as unknown as Parameters<typeof contract.post>[1])).toBe(true);
    for (const target of [undefined, "br_none", "br_other", "br_loop1", "br_new"]) {
      expect(validateBountyTriageResult({ ...base, raw: { verdict: "duplicate", duplicate_of: target, reason: "同じ" } }).ok).toBe(false);
    }
  });

  it("takes an estimated project only within the registry and the company scope, and requires one to accept", () => {
    const unknown = { ...base, report: { id: "br_new", project_code: null } };
    expect(validateBountyTriageResult({ ...unknown, raw: { ...accepted, project: "At" } })).toMatchObject({ ok: true, value: { project: "At" } });
    expect(validateBountyTriageResult({ ...unknown, raw: { ...accepted, project: "Zz" } }).ok).toBe(false);
    expect(validateBountyTriageResult({ ...unknown, companyProjects: ["Cc"], raw: { ...accepted, project: "At" } }).ok).toBe(false);
    expect(validateBountyTriageResult({ ...unknown, raw: accepted })).toEqual({ ok: false, errors: ["project_required"] });
  });

  it("resolveDuplicateRoot stops on a cycle", () => {
    expect(resolveDuplicateRoot("br_dup", find)?.id).toBe("br_root");
    expect(resolveDuplicateRoot("br_loop1", find)).toBeNull();
  });
});
