import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import { BOUNTY_REPORT_MODAL_ID } from "../bounty-modal.js";
import bugCommand, { type BountyCommandDeps } from "./bug.js";

function bountyDeps(overrides: Partial<BountyCommandDeps> = {}): BountyCommandDeps {
  return {
    runtimeSubsidiaryId: null,
    submit: vi.fn(),
    setPublicName: vi.fn(async () => ({ ok: true as const, display: "neco" })),
    withdraw: vi.fn(async () => ({
      ok: true as const,
      receipt: { report_id: "br_abc", status: "withdrawn", project: "Cc", missing: [], reporter: "匿名", has_recipient: true },
    })),
    projects: () => [{ code: "Cc", project: "Concordia" }, { code: "At", project: "Actio" }],
    currentPublicName: () => "neco",
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function command(sub: string, options: Record<string, string | null> = {}) {
  const interaction = {
    user: { id: "905235114026467350" },
    options: {
      getSubcommand: () => sub,
      getString: (name: string) => options[name] ?? null,
    },
    showModal: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return interaction;
}

describe("/bug (bug-bounty.md §3 §4)", () => {
  it("declares report, name and withdraw", () => {
    const json = bugCommand.builder.toJSON() as { name: string; options: Array<{ name: string }> };
    expect(json.name).toBe("bug");
    expect(json.options.map((option) => option.name)).toEqual(["report", "name", "withdraw"]);
  });

  it("opens the report modal with the chosen project and the caller's own public name", async () => {
    const interaction = command("report", { project: "Cc" });
    await bugCommand.execute(interaction as unknown as ChatInputCommandInteraction, { bounty: bountyDeps() } as unknown as DiscordCommandDeps);
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = (interaction.showModal.mock.calls[0] as unknown as [{ toJSON(): { custom_id: string; components: Array<{ components: Array<{ custom_id: string; value?: string }> }> } }])[0].toJSON();
    expect(modal.custom_id).toBe(BOUNTY_REPORT_MODAL_ID);
    const values = Object.fromEntries(modal.components.map((row) => [row.components[0]!.custom_id, row.components[0]!.value]));
    expect(values).toMatchObject({ project: "Cc", public_name: "neco" });
  });

  it("routes name and withdraw to their handlers and answers only the caller", async () => {
    const bounty = bountyDeps();
    const name = command("name", { name: "neco" });
    await bugCommand.execute(name as unknown as ChatInputCommandInteraction, { bounty } as unknown as DiscordCommandDeps);
    expect(bounty.setPublicName).toHaveBeenCalledWith({ userId: "905235114026467350", publicName: "neco" });
    expect(name.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(name.showModal).not.toHaveBeenCalled();

    const withdraw = command("withdraw", { id: "br_abc" });
    await bugCommand.execute(withdraw as unknown as ChatInputCommandInteraction, { bounty } as unknown as DiscordCommandDeps);
    expect(bounty.withdraw).toHaveBeenCalledWith({ reportId: "br_abc", userId: "905235114026467350" });
    expect(withdraw.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("says so when the Bot is not wired for bug reports", async () => {
    const interaction = command("report");
    await bugCommand.execute(interaction as unknown as ChatInputCommandInteraction, {} as DiscordCommandDeps);
    expect(interaction.reply).toHaveBeenCalledWith({ content: "バグ報告はこの Bot で使えません。", ephemeral: true });
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it("completes project codes from the projects this company may report on", async () => {
    const respond = vi.fn(async () => undefined);
    const interaction = { options: { getFocused: () => "act" }, respond } as unknown as AutocompleteInteraction;
    await bugCommand.autocomplete!(interaction, { bounty: bountyDeps() } as unknown as DiscordCommandDeps);
    expect(respond).toHaveBeenCalledWith([{ name: "At — Actio", value: "At" }]);

    const unwired = vi.fn(async () => undefined);
    await bugCommand.autocomplete!(
      { options: { getFocused: () => "" }, respond: unwired } as unknown as AutocompleteInteraction,
      {} as DiscordCommandDeps,
    );
    expect(unwired).toHaveBeenCalledWith([]);
  });
});
