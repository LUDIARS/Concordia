import { describe, expect, it } from "vitest";

import {
  CAPABILITY_MIN_ROLE,
  STAFF_CAPABILITIES,
  capabilitiesForRole,
  capabilityAllowed,
  isStaffRole,
  roleAtLeast,
} from "./roles.js";

describe("staff roles", () => {
  it("treats unregistered users as ヒラ社員 who may only converse", () => {
    expect(capabilityAllowed(null, "converse")).toBe(true);
    expect(capabilityAllowed(undefined, "converse")).toBe(true);
    for (const capability of STAFF_CAPABILITIES) {
      if (capability === "converse") continue;
      expect(capabilityAllowed(null, capability)).toBe(false);
    }
  });

  it("lets 管理職 spawn and end sessions but not flip the kill switch", () => {
    expect(capabilityAllowed("manager", "session_spawn")).toBe(true);
    expect(capabilityAllowed("manager", "session_end")).toBe(true);
    expect(capabilityAllowed("manager", "reaction_workflow")).toBe(true);
    expect(capabilityAllowed("manager", "kill_switch")).toBe(false);
  });

  it("gives 執行役員 every capability", () => {
    for (const capability of STAFF_CAPABILITIES) {
      expect(capabilityAllowed("executive", capability)).toBe(true);
    }
    expect(capabilitiesForRole("executive")).toEqual([...STAFF_CAPABILITIES]);
  });

  it("orders roles so that upper roles subsume lower ones", () => {
    expect(roleAtLeast("executive", "manager")).toBe(true);
    expect(roleAtLeast("manager", "executive")).toBe(false);
    expect(roleAtLeast("staff", "staff")).toBe(true);
  });

  it("declares a minimum role for every capability", () => {
    for (const capability of STAFF_CAPABILITIES) {
      expect(CAPABILITY_MIN_ROLE[capability]).toBeDefined();
    }
  });

  it("validates role strings coming from the API", () => {
    expect(isStaffRole("manager")).toBe(true);
    expect(isStaffRole("ceo")).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });
});
