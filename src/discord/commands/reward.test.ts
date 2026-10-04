import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import type { PersonalBudgetCommandDeps } from "../personal-budget-discord.js";
import rewardCommand from "./reward.js";

function budgetDeps(reward = vi.fn(async () => "alice (GLAB) の報酬分を +500,000 しました。")): PersonalBudgetCommandDeps {
  return {
    renderBudget: () => "",
    reward,
    subsidiaryChoices: () => [{ id: "sub-glab", name: "GLAB" }, { id: "sub-vantan", name: "Vantan" }],
  };
}

function command(options: { tokens: number; reason: string; subsidiary?: string | null }) {
  const reply = vi.fn(async () => undefined);
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const interaction = {
    user: { id: "900" },
    options: {
      getUser: () => ({ id: "111", username: "alice_raw", globalName: "alice" }),
      getInteger: () => options.tokens,
      getString: (name: string) => (name === "reason" ? options.reason : options.subsidiary ?? null),
    },
    reply,
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, deferReply, editReply };
}

describe("/reward", () => {
  it("passes who, how much and why to the adjustment and answers only the operator", async () => {
    const reward = vi.fn(async () => "alice (GLAB) の報酬分を +500,000 しました。");
    const { interaction, deferReply, editReply } = command({ tokens: 500_000, reason: "勉強会の登壇", subsidiary: " sub-glab " });
    await rewardCommand.execute(interaction, { personalBudget: budgetDeps(reward) } as unknown as DiscordCommandDeps);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(reward).toHaveBeenCalledWith({
      actorUserId: "900", targetUserId: "111", targetLabel: "alice", tokens: 500_000, reason: "勉強会の登壇", subsidiaryId: "sub-glab",
    });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("+500,000"), allowedMentions: { parse: [] },
    }));
  });

  it("leaves the subsidiary unset when the option is omitted", async () => {
    const reward = vi.fn(async () => "ok");
    const { interaction } = command({ tokens: -100, reason: "訂正" });
    await rewardCommand.execute(interaction, { personalBudget: budgetDeps(reward) } as unknown as DiscordCommandDeps);
    expect(reward).toHaveBeenCalledWith(expect.objectContaining({ tokens: -100, subsidiaryId: null }));
  });

  it("is refused outside the head-office server, without touching the ledger", async () => {
    const reward = vi.fn(async () => "ok");
    const { interaction, reply, deferReply } = command({ tokens: 100, reason: "お礼" });
    await rewardCommand.execute(interaction, { personalBudget: budgetDeps(reward), subsidiaryId: "sub-glab" } as unknown as DiscordCommandDeps);
    expect(reward).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, content: expect.stringContaining("本社") }));
  });

  it("is unavailable where the personal budget is not wired", async () => {
    const { interaction, reply } = command({ tokens: 100, reason: "お礼" });
    await rewardCommand.execute(interaction, {} as DiscordCommandDeps);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("completes subsidiaries by name in the head office only", async () => {
    const respond = vi.fn(async () => undefined);
    const interaction = { options: { getFocused: () => "Van" }, respond } as unknown as AutocompleteInteraction;
    await rewardCommand.autocomplete!(interaction, { personalBudget: budgetDeps() } as unknown as DiscordCommandDeps);
    expect(respond).toHaveBeenCalledWith([{ name: "Vantan", value: "sub-vantan" }]);

    await rewardCommand.autocomplete!(interaction, { personalBudget: budgetDeps(), subsidiaryId: "sub-glab" } as unknown as DiscordCommandDeps);
    expect(respond).toHaveBeenLastCalledWith([]);
  });

  it("declares the options the spec names, with a required reason", () => {
    const json = rewardCommand.builder.toJSON() as { name: string; options: Array<{ name: string; required?: boolean }> };
    expect(json.name).toBe("reward");
    expect(json.options.map((option) => [option.name, option.required === true])).toEqual([
      ["user", true], ["tokens", true], ["reason", true], ["subsidiary", false],
    ]);
  });
});
