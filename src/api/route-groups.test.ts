import { describe, expect, it } from "vitest";
import { mountRouteGroups } from "./route-groups.js";

describe("mountRouteGroups", () => {
  it("mounts named groups once and rejects ambiguous ownership", () => {
    const calls: string[] = [];
    mountRouteGroups([
      { name: "sessions", mount: () => calls.push("sessions") },
      { name: "admin", mount: () => calls.push("admin") },
    ]);
    expect(calls).toEqual(["sessions", "admin"]);
    expect(() => mountRouteGroups([
      { name: "same", mount: () => undefined },
      { name: "same", mount: () => undefined },
    ])).toThrow(/duplicate route group/);
  });
});
