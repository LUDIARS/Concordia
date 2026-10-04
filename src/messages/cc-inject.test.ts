import { expect, it } from "vitest";
import { isCcInjectSource } from "./cc-inject.js";
it("separates Cc automation from human input on the same transport", () => {
  for (const source of ["cc-session-work-policy", "auto:inquiry", "revisor"]) expect(isCcInjectSource(source)).toBe(true);
  for (const source of ["web-ui", "discord:123:456:789", "slack:U:C:T", null]) expect(isCcInjectSource(source)).toBe(false);
});
