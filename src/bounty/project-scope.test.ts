import { describe, expect, it } from "vitest";
import { bountyProjectsInScope, checkBountyReportProject } from "./project-scope.js";

const registered = [
  { code: "Cc", project: "Concordia" },
  { code: "At", project: "Actio" },
  { code: "LD", project: "LiveDecorator" },
  { code: "Ld", project: "LUDIARS" },
];

describe("checkBountyReportProject (bug-bounty.md §3)", () => {
  it("accepts a registered code for the head office", () => {
    expect(checkBountyReportProject({ code: "Cc", registered, companyProjects: null }))
      .toEqual({ ok: true, project: { code: "Cc", project: "Concordia" } });
  });

  it("passes an unspecified project as unknown so triage can infer it", () => {
    expect(checkBountyReportProject({ code: null, registered, companyProjects: null })).toEqual({ ok: true, project: null });
    expect(checkBountyReportProject({ code: "  ", registered, companyProjects: ["Actio"] })).toEqual({ ok: true, project: null });
  });

  it("refuses an unregistered code", () => {
    expect(checkBountyReportProject({ code: "Zz", registered, companyProjects: null }))
      .toEqual({ ok: false, denial: "unknown_project" });
  });

  it("keeps codes case-sensitive and folds case only when the match is unique", () => {
    expect(checkBountyReportProject({ code: "cc", registered, companyProjects: null }))
      .toEqual({ ok: true, project: { code: "Cc", project: "Concordia" } });
    expect(checkBountyReportProject({ code: "LD", registered, companyProjects: null }))
      .toEqual({ ok: true, project: { code: "LD", project: "LiveDecorator" } });
    // `ld` は LD と Ld の両方に当たるので決めない。
    expect(checkBountyReportProject({ code: "ld", registered, companyProjects: null }))
      .toEqual({ ok: false, denial: "unknown_project" });
  });

  it("limits a subsidiary to its related projects, by name or by code (CC-INV-02)", () => {
    expect(checkBountyReportProject({ code: "At", registered, companyProjects: ["actio"] }).ok).toBe(true);
    expect(checkBountyReportProject({ code: "At", registered, companyProjects: ["AT"] }).ok).toBe(true);
    expect(checkBountyReportProject({ code: "Cc", registered, companyProjects: ["Actio"] }))
      .toEqual({ ok: false, denial: "project_outside_company_scope" });
    expect(checkBountyReportProject({ code: "Cc", registered, companyProjects: [] }))
      .toEqual({ ok: false, denial: "project_outside_company_scope" });
  });
});

describe("bountyProjectsInScope", () => {
  it("lists every project for the head office and only related projects for a subsidiary", () => {
    expect(bountyProjectsInScope(registered, null)).toHaveLength(4);
    expect(bountyProjectsInScope(registered, ["Actio", "concordia"]).map((project) => project.code)).toEqual(["Cc", "At"]);
  });
});
