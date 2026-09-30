import { describe, expect, it } from "vitest";
import { isOutputEnabled, resolveSessionOutputMode, type SessionOutputPorts } from "./output-policy.js";

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
