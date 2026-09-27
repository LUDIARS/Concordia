import { describe, expect, it } from "vitest";
import { assertStaticBundle } from "./test-scope.js";
describe("runtime test boundary", () => {
  const records = [
    { id: "unit", runtime: false, status: "active", domains: { business: ["core"], program: [] } },
    { id: "boot", runtime: true, status: "active", domains: { business: ["startup"], program: [] } },
  ];
  it("rejects a bundle that could start a service", () => {
    expect(() => assertStaticBundle(records, "all")).toThrow("runtime_test_workflow_required");
    expect(() => assertStaticBundle(records, "ids:boot")).toThrow("runtime_test_workflow_required");
  });
  it("allows an explicitly selected static bundle without broadening it", () => {
    expect(() => assertStaticBundle(records, "ids:unit")).not.toThrow();
    expect(() => assertStaticBundle(records, "domain:core")).not.toThrow();
  });
});
