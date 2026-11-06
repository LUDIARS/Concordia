import { describe, expect, it } from "vitest";
import { monitorDeliveryAction } from "./monitor-delivery-policy.js";

describe("monitorDeliveryAction", () => {
  it("fences ambiguous creations even after restart", () => {
    expect(monitorDeliveryAction("sending", false)).toBe("reconcile");
    expect(monitorDeliveryAction("sending", true)).toBe("edit");
    expect(monitorDeliveryAction("ready", false)).toBe("missing");
    expect(monitorDeliveryAction(null, false)).toBe("create");
  });
});
