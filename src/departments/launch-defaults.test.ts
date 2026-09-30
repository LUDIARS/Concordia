import { describe, expect, it } from "vitest";
import { applyDepartmentLaunchDefaults, isProjectInDepartment } from "./launch-defaults.js";
import type { DepartmentSettings } from "./settings.js";

type LaunchSettings = Pick<DepartmentSettings, "launch" | "projects">;

const templateDepartment: LaunchSettings = {
  launch: { template: "claude-opus-impl", model: "opus", reasoning_effort: "high", project: "Concordia" },
  projects: ["Concordia", "Lictor"],
};

describe("applyDepartmentLaunchDefaults", () => {
  it("fills every unspecified item from the department defaults", () => {
    expect(applyDepartmentLaunchDefaults({}, templateDepartment)).toEqual({
      ok: true,
      launch: {
        template: "claude-opus-impl", provider: null, model: "opus",
        reasoning_effort: "high", project: "Concordia", cwd: null,
      },
    });
  });

  it("never overrides explicit values (CC-DEPT-INV-05)", () => {
    const result = applyDepartmentLaunchDefaults(
      { template: "codex-review", model: "gpt-5", reasoning_effort: "low", project: "Lictor" },
      templateDepartment,
    );
    expect(result).toEqual({
      ok: true,
      launch: {
        template: "codex-review", provider: null, model: "gpt-5",
        reasoning_effort: "low", project: "Lictor", cwd: null,
      },
    });
  });

  it("does not add the department template when the request chose a provider", () => {
    const result = applyDepartmentLaunchDefaults({ provider: "codex" }, templateDepartment);
    expect(result.ok && result.launch).toMatchObject({ template: null, provider: "codex", model: "opus" });
  });

  it("uses the department provider only when neither kind was requested", () => {
    const providerDepartment: LaunchSettings = { launch: { provider: "codex" }, projects: [] };
    expect(applyDepartmentLaunchDefaults({}, providerDepartment)).toMatchObject({ ok: true, launch: { provider: "codex" } });
    expect(applyDepartmentLaunchDefaults({ template: "t" }, providerDepartment))
      .toMatchObject({ ok: true, launch: { template: "t", provider: null } });
  });

  it("rejects projects outside the department and raw cwd when projects are set (CC-DEPT-INV-04)", () => {
    expect(applyDepartmentLaunchDefaults({ project: "Memoria" }, templateDepartment))
      .toEqual({ ok: false, denial: "department_project_out_of_scope" });
    expect(applyDepartmentLaunchDefaults({ cwd: "E:/Document/Ars/Memoria" }, templateDepartment))
      .toEqual({ ok: false, denial: "department_cwd_not_allowed" });
  });

  it("requires a project for a restricted department without a default project", () => {
    const restricted: LaunchSettings = { launch: {}, projects: ["Concordia"] };
    expect(applyDepartmentLaunchDefaults({}, restricted)).toEqual({ ok: false, denial: "department_project_required" });
  });

  it("keeps an explicit cwd for an unrestricted department without adding the default project", () => {
    const open: LaunchSettings = { launch: { project: "Concordia" }, projects: [] };
    expect(applyDepartmentLaunchDefaults({ cwd: "E:/work" }, open))
      .toMatchObject({ ok: true, launch: { cwd: "E:/work", project: null } });
  });

  it("treats blank strings as unspecified", () => {
    expect(applyDepartmentLaunchDefaults({ template: "  ", project: "" }, templateDepartment))
      .toMatchObject({ ok: true, launch: { template: "claude-opus-impl", project: "Concordia" } });
  });
});

describe("isProjectInDepartment", () => {
  it("matches case-insensitively and rejects blanks", () => {
    expect(isProjectInDepartment("concordia", ["Concordia"])).toBe(true);
    expect(isProjectInDepartment(" ", ["Concordia"])).toBe(false);
  });
});
