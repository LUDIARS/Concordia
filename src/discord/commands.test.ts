import { describe, expect, it } from "vitest";
import { commandNamesForRegistration, isSubsidiaryAllowedCommand } from "./commands.js";

describe("Discord command registration", () => {
  it("registers only safe session commands for subsidiary guilds", () => {
    expect(commandNamesForRegistration({ subsidiary: true })).toEqual(["ch_name"]);
    expect(isSubsidiaryAllowedCommand("ch_name")).toBe(true);
    expect(isSubsidiaryAllowedCommand("spawn")).toBe(false);
  });

  it("keeps the full command set for head-office guilds", () => {
    const names = commandNamesForRegistration();
    expect(names).toContain("spawn");
    expect(names).toContain("ch_name");
    expect(names.length).toBeGreaterThan(1);
  });
});
