import { describe, expect, it } from "vitest";
import { isOutputEnabled, resolveSessionOutputMode, type SessionOutputPorts } from "./output-policy.js";
import { effectiveDepartmentOutput } from "./output-policy.js";
import { DEFAULT_OUTPUT_POLICY } from "./settings.js";

it("keeps HQ and subsidiary defaults separate and preserves explicit settings", () => {
  const hq = { subsidiary_id: null, slug: "general" };
  const child = { subsidiary_id: "child", slug: "general" };
  expect(effectiveDepartmentOutput(DEFAULT_OUTPUT_POLICY, hq).intermediate).toBe(true);
  expect(effectiveDepartmentOutput(DEFAULT_OUTPUT_POLICY, child).intermediate).toBe(false);
  expect(effectiveDepartmentOutput({ ...DEFAULT_OUTPUT_POLICY, intermediate: "on" }, child).intermediate).toBe(true);
  expect(effectiveDepartmentOutput(DEFAULT_OUTPUT_POLICY, { ...child, slug: "engineering" }).intermediate).toBe(true);
  expect(resolveSessionOutputMode({ ...ports("{}"), departmentIdentity: () => child }, "s", "intermediate")).toBe("off");
});
it("uses the actual global thinking setting for inherited presentation", () => {
  const hq = { subsidiary_id: null, slug: "general" };
  expect(effectiveDepartmentOutput(DEFAULT_OUTPUT_POLICY, hq).thinking).toBe(false);
  expect(effectiveDepartmentOutput(DEFAULT_OUTPUT_POLICY, hq, { thinking: true }).thinking).toBe(true);
  expect(effectiveDepartmentOutput({ ...DEFAULT_OUTPUT_POLICY, thinking: "off" }, hq, { thinking: true }).thinking).toBe(false);
});

function ports(settingsJson: string | null, departmentId: string | null = "dept-qa"): SessionOutputPorts & { broken: string[] } {
  const broken: string[] = [];
  return {
    broken,
    sessionDepartmentId: () => departmentId,
    departmentSettingsJson: () => settingsJson,
    onBrokenSettings: (id) => { broken.push(id); },
  };
}

describe("isOutputEnabled", () => {
  it("follows the global setting only for inherit", () => {
    expect(isOutputEnabled("inherit", true)).toBe(true);
    expect(isOutputEnabled("inherit", false)).toBe(false);
    expect(isOutputEnabled("on", false)).toBe(true);
    expect(isOutputEnabled("off", true)).toBe(false);
  });
});

describe("resolveSessionOutputMode", () => {
  it("uses subsidiary general defaults while retaining HQ and explicit overrides", () => {
    const p = ports("{}");
    p.departmentIdentity = () => ({subsidiary_id:"sub",slug:"general-affairs"});
    expect(resolveSessionOutputMode(p,"s","intermediate")).toBe("off");
    p.departmentIdentity = () => ({subsidiary_id:null,slug:"general-affairs"});
    expect(resolveSessionOutputMode(p,"s","intermediate")).toBe("inherit");
    p.departmentIdentity = () => ({subsidiary_id:"sub",slug:"other"});
    expect(resolveSessionOutputMode(p,"s","intermediate")).toBe("inherit");
    const explicit = ports(JSON.stringify({output:{intermediate:"on"}}));
    explicit.departmentIdentity = () => ({subsidiary_id:"sub",slug:"general"});
    expect(resolveSessionOutputMode(explicit,"s","intermediate")).toBe("on");
  });
  it("reads the department policy for the item", () => {
    const json = JSON.stringify({ output: { thinking: "off", status_card: "on" } });
    expect(resolveSessionOutputMode(ports(json), "s", "thinking")).toBe("off");
    expect(resolveSessionOutputMode(ports(json), "s", "status_card")).toBe("on");
    expect(resolveSessionOutputMode(ports(json), "s", "cost_report")).toBe("inherit");
  });

  it("inherits for unassigned sessions and missing departments", () => {
    expect(resolveSessionOutputMode(ports("{}", null), "s", "thinking")).toBe("inherit");
    expect(resolveSessionOutputMode(ports(null), "s", "thinking")).toBe("inherit");
  });

  it("inherits and reports a broken settings row instead of hiding it", () => {
    const broken = ports("{broken");
    expect(resolveSessionOutputMode(broken, "s", "thinking")).toBe("inherit");
    expect(broken.broken).toEqual(["dept-qa"]);
  });
});
