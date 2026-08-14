import { describe, expect, it } from "vitest";
import { readStoredTeamId, resolveSelectedTeamId } from "./team-filter-core.js";

describe("readStoredTeamId", () => {
  it("normalizes empty and whitespace values to null", () => {
    expect(readStoredTeamId(null)).toBeNull();
    expect(readStoredTeamId("")).toBeNull();
    expect(readStoredTeamId("  ")).toBeNull();
    expect(readStoredTeamId("team-1")).toBe("team-1");
    expect(readStoredTeamId("x".repeat(201))).toBeNull();
  });
});

describe("resolveSelectedTeamId", () => {
  const teams = [{ id: "team-1" }, { id: "team-2" }];
  it("keeps a selection that still exists", () => {
    expect(resolveSelectedTeamId("team-2", teams)).toBe("team-2");
  });
  it("drops a stale selection for a deleted team", () => {
    expect(resolveSelectedTeamId("team-gone", teams)).toBeNull();
    expect(resolveSelectedTeamId(null, teams)).toBeNull();
  });
});
