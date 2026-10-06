import { describe, expect, it } from "vitest";
import { DepartmentSettingsSchema, parseDepartmentSettings } from "./settings.js";

describe("DepartmentSettingsSchema", () => {
  it("fills empty launch defaults, projects, an inherit-everything output policy and closed private consultation", () => {
    expect(DepartmentSettingsSchema.parse({})).toEqual({
      launch: {},
      projects: [],
      output: { thinking: "inherit", status_card: "inherit", session_info_card: "inherit", cost_report: "inherit",
        intermediate: "inherit", inject_transcript: "inherit", context_usage: "inherit", session_end_report: "inherit" },
      private: { enabled: false, approver_min_role: "manager" },
      startup_inject: "full",
      auto_check: "on",
      budget: { cost_multiplier: 1 },
      consult_tools: "restricted",
    });
  });

  it("accepts a default project that is one of the department projects", () => {
    const parsed = DepartmentSettingsSchema.parse({
      launch: { template: "claude-opus-impl", model: "opus", reasoning_effort: "high", project: "concordia" },
      projects: ["Concordia", "Lictor"],
    });
    expect(parsed.launch.project).toBe("concordia");
  });

  it("rejects a default project outside the department projects", () => {
    const result = DepartmentSettingsSchema.safeParse({ launch: { project: "Memoria" }, projects: ["Concordia"] });
    expect(result.success).toBe(false);
  });

  it("rejects a template and a provider as competing launch kinds", () => {
    const result = DepartmentSettingsSchema.safeParse({ launch: { template: "t", provider: "codex" } });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate projects regardless of case and invalid project names", () => {
    expect(DepartmentSettingsSchema.safeParse({ projects: ["Concordia", "concordia"] }).success).toBe(false);
    expect(DepartmentSettingsSchema.safeParse({ projects: ["../etc"] }).success).toBe(false);
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    expect(DepartmentSettingsSchema.safeParse({ launch: { cwd: "C:/" } }).success).toBe(false);
    expect(DepartmentSettingsSchema.safeParse({ budget: 1 }).success).toBe(false);
  });
});

describe("parseDepartmentSettings", () => {
  it("throws for a broken stored row rather than returning empty defaults", () => {
    expect(() => parseDepartmentSettings("{not json")).toThrow();
    expect(() => parseDepartmentSettings(JSON.stringify({ launch: { template: "a", provider: "b" } }))).toThrow();
  });

  it("defaults the budget cost multiplier to 1 and keeps it within (0, 10]", () => {
    expect(DepartmentSettingsSchema.parse({}).budget).toEqual({ cost_multiplier: 1 });
    expect(DepartmentSettingsSchema.parse({ budget: { cost_multiplier: 0.25 } }).budget.cost_multiplier).toBe(0.25);
    expect(DepartmentSettingsSchema.safeParse({ budget: { cost_multiplier: 0 } }).success).toBe(false);
    expect(DepartmentSettingsSchema.safeParse({ budget: { cost_multiplier: 11 } }).success).toBe(false);
  });

  it("accepts a private consultation setting and rejects an unknown approver role", () => {
    expect(DepartmentSettingsSchema.parse({ private: { enabled: true } }).private)
      .toEqual({ enabled: true, approver_min_role: "manager" });
    expect(DepartmentSettingsSchema.safeParse({ private: { enabled: true, approver_min_role: "staff" } }).success).toBe(false);
  });
});
