import { describe, expect, it } from "vitest";

import {
  CAPABILITY_MIN_ROLE,
  STAFF_CAPABILITIES,
  capabilitiesForRole,
  capabilityAllowed,
  isStaffRole,
  roleAtLeast,
} from "./roles.js";
import type { StaffCapability } from "./roles.js";

describe("staff roles", () => {
  // 未登録でも「会話」と「リアクションでの指示」はできる。 リアクションは指示の簡略化で
  // あって権限ではない (neco 2026-08-01) — 実行できるかは中身が要求する権限で決まる。
  // StaffCapability で型付けしておく (綴り違いをコンパイル時に落とすため)。
  const OPEN_TO_EVERYONE: readonly StaffCapability[] = ["converse", "reaction_workflow"];

  it("lets unregistered users converse and fire reactions, nothing more", () => {
    for (const capability of OPEN_TO_EVERYONE) {
      expect(capabilityAllowed(null, capability)).toBe(true);
      expect(capabilityAllowed(undefined, capability)).toBe(true);
    }
    for (const capability of STAFF_CAPABILITIES) {
      if (OPEN_TO_EVERYONE.includes(capability)) continue;
      expect(capabilityAllowed(null, capability)).toBe(false);
    }
  });

  it("lets 管理職 spawn and end sessions but not flip the kill switch", () => {
    expect(capabilityAllowed("manager", "session_spawn")).toBe(true);
    expect(capabilityAllowed("manager", "session_end")).toBe(true);
    expect(capabilityAllowed("manager", "merge_pr")).toBe(true);
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
