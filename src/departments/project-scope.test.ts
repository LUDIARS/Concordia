import { describe, expect, it } from "vitest";
import { checkDepartmentProjects } from "./project-scope.js";

describe("checkDepartmentProjects", () => {
  it("does not restrict head-office departments", () => {
    expect(checkDepartmentProjects(["Anything"], null)).toEqual({ ok: true });
  });

  it("allows a subsidiary department inside the subsidiary projects (CC-DEPT-INV-03)", () => {
    expect(checkDepartmentProjects(["glab-web"], ["GLAB-Web", "glab-api"])).toEqual({ ok: true });
    expect(checkDepartmentProjects([], ["glab-web"])).toEqual({ ok: true });
  });

  it("lists the projects outside the subsidiary scope", () => {
    expect(checkDepartmentProjects(["glab-web", "Concordia"], ["glab-web"])).toEqual({
      ok: false, denial: "department_projects_outside_subsidiary_scope", outside: ["Concordia"],
    });
  });

  it("treats an unconfigured subsidiary scope as allowing nothing", () => {
    expect(checkDepartmentProjects(["glab-web"], [])).toMatchObject({ ok: false, outside: ["glab-web"] });
  });
});
