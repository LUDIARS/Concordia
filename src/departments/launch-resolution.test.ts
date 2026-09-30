import { describe, expect, it } from "vitest";
import type { DepartmentRow } from "../db/departments-repo.js";
import { resolveDepartmentLaunch, type DepartmentLookupPort } from "./launch-resolution.js";

function department(overrides: Partial<DepartmentRow> = {}): DepartmentRow {
  return {
    id: "dept-dev",
    subsidiary_id: null,
    name: "開発部",
    slug: "dev",
    description: "",
    settings_json: JSON.stringify({ launch: { template: "claude-opus-impl", project: "Concordia" }, projects: ["Concordia"] }),
    rules_text: "",
    sort_order: 0,
    use_case_id: null,
    is_default: 0,
    discord_forum_id: null,
    archived_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function lookup(...rows: DepartmentRow[]): DepartmentLookupPort {
  return { find: (id) => rows.find((row) => row.id === id) ?? null };
}

const baseInput = { organizationId: null, teamDepartmentId: null, request: {}, applyDefaults: true };

describe("resolveDepartmentLaunch", () => {
  it("passes an unassigned launch through unchanged (CC-DEPT-INV-08)", () => {
    const result = resolveDepartmentLaunch(lookup(), { ...baseInput, departmentId: null, request: { provider: "codex", cwd: "E:/x" } });
    expect(result).toEqual({
      ok: true,
      department: null,
      launch: { template: null, provider: "codex", model: null, reasoning_effort: null, project: null, cwd: "E:/x" },
    });
  });

  it("applies department defaults for the owning organization", () => {
    const result = resolveDepartmentLaunch(lookup(department()), { ...baseInput, departmentId: "dept-dev" });
    expect(result).toMatchObject({ ok: true, department: { id: "dept-dev" }, launch: { template: "claude-opus-impl", project: "Concordia" } });
  });

  it("infers the department from the team and rejects a mismatch", () => {
    expect(resolveDepartmentLaunch(lookup(department()), { ...baseInput, departmentId: null, teamDepartmentId: "dept-dev" }))
      .toMatchObject({ ok: true, department: { id: "dept-dev" } });
    expect(resolveDepartmentLaunch(lookup(department()), { ...baseInput, departmentId: "dept-other", teamDepartmentId: "dept-dev" }))
      .toEqual({ ok: false, error: "team_department_mismatch" });
  });

  it("rejects unknown, archived and foreign departments", () => {
    expect(resolveDepartmentLaunch(lookup(), { ...baseInput, departmentId: "dept-dev" }))
      .toEqual({ ok: false, error: "department_not_found" });
    expect(resolveDepartmentLaunch(lookup(department({ archived_at: 5 })), { ...baseInput, departmentId: "dept-dev" }))
      .toEqual({ ok: false, error: "department_archived" });
    expect(resolveDepartmentLaunch(lookup(department()), { ...baseInput, departmentId: "dept-dev", organizationId: "glab" }))
      .toEqual({ ok: false, error: "department_not_owned_by_requested_organization" });
  });

  it("checks ownership without applying defaults for delegations", () => {
    const result = resolveDepartmentLaunch(lookup(department()), {
      ...baseInput, departmentId: "dept-dev", applyDefaults: false, request: { project: "Memoria" },
    });
    expect(result).toMatchObject({ ok: true, launch: { template: null, project: "Memoria" } });
  });

  it("reports scope denials from the defaults", () => {
    expect(resolveDepartmentLaunch(lookup(department()), { ...baseInput, departmentId: "dept-dev", request: { project: "Memoria" } }))
      .toEqual({ ok: false, error: "department_project_out_of_scope" });
  });

  it("refuses to launch from a department whose stored settings are broken", () => {
    const broken = department({ settings_json: "{broken" });
    expect(resolveDepartmentLaunch(lookup(broken), { ...baseInput, departmentId: "dept-dev" }))
      .toEqual({ ok: false, error: "department_settings_invalid" });
  });
});
