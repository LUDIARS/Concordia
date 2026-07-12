import { describe, expect, it, vi } from "vitest";
import {
  commandNamesForRegistration,
  dispatchInteraction,
  isSubsidiaryAllowedCommand,
  isSubsidiaryAllowedInteraction,
} from "./commands.js";

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
    expect(names).toContain("ex-run");
    expect(names).toContain("ex-reboot");
    expect(names).not.toContain("skill");
    expect(names.length).toBeGreaterThan(1);
  });

  it.each(["ctrl:spawn:codex", "ctrl:end-session"]) (
    "rejects subsidiary control interaction %s before dispatch",
    async (customId) => {
      const reply = vi.fn(async () => undefined);
      const interaction = {
        type: 3,
        customId,
        isAutocomplete: () => false,
        isRepliable: () => true,
        reply,
      };
      await dispatchInteraction(interaction as never, {
        subsidiaryId: "sub-1",
        log: { info: vi.fn(), warn: vi.fn() },
      } as never);
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
      expect(isSubsidiaryAllowedInteraction(interaction as never)).toBe(false);
    },
  );
});
