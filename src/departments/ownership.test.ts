import { describe, expect, it } from "vitest";
import { checkDepartmentOwnership, reconcileTeamDepartment } from "./ownership.js";

const headOffice = { id: "dept-hq", subsidiary_id: null, archived_at: null };
const subsidiary = { id: "dept-glab", subsidiary_id: "glab", archived_at: null };

describe("checkDepartmentOwnership", () => {
  it("allows a department only for the organization that owns it", () => {
    expect(checkDepartmentOwnership(headOffice, null)).toEqual({ ok: true });
    expect(checkDepartmentOwnership(subsidiary, "glab")).toEqual({ ok: true });
  });

  it("rejects crossing between head office and subsidiaries (CC-DEPT-INV-02)", () => {
    expect(checkDepartmentOwnership(headOffice, "glab")).toEqual({
      ok: false, denial: "department_not_owned_by_requested_organization",
    });
    expect(checkDepartmentOwnership(subsidiary, null)).toEqual({
      ok: false, denial: "department_not_owned_by_requested_organization",
    });
    expect(checkDepartmentOwnership(subsidiary, "pagus-vob")).toEqual({
      ok: false, denial: "department_not_owned_by_requested_organization",
    });
  });

  it("rejects new launches from an archived department (CC-DEPT-INV-06)", () => {
    expect(checkDepartmentOwnership({ ...headOffice, archived_at: 10 }, null)).toEqual({
      ok: false, denial: "department_archived",
    });
  });
});

describe("reconcileTeamDepartment", () => {
  it("keeps the requested department when the team is not assigned", () => {
    expect(reconcileTeamDepartment(null, "dept-a")).toEqual({ ok: true, departmentId: "dept-a" });
    expect(reconcileTeamDepartment(null, null)).toEqual({ ok: true, departmentId: null });
  });

  it("infers the team's department when none was requested", () => {
    expect(reconcileTeamDepartment("dept-a", null)).toEqual({ ok: true, departmentId: "dept-a" });
  });

  it("rejects a team and department that disagree (CC-DEPT-INV-07)", () => {
    expect(reconcileTeamDepartment("dept-a", "dept-b")).toEqual({ ok: false, denial: "team_department_mismatch" });
    expect(reconcileTeamDepartment("dept-a", "dept-a")).toEqual({ ok: true, departmentId: "dept-a" });
  });
});
