import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import budgetCommand from "./budget.js";

function run(deps: Partial<DiscordCommandDeps>) {
  const reply = vi.fn(async () => undefined);
  const interaction = { user: { id: "111" }, reply } as unknown as ChatInputCommandInteraction;
  return { reply, done: budgetCommand.execute(interaction, deps as DiscordCommandDeps) };
}

describe("/budget", () => {
  it("replies only to the caller with their own budget (CC-PBUDGET-INV-08)", async () => {
    const renderBudget = vi.fn(() => "**GLAB** の個人の AI 予算\n- 報酬分の残り: 300,000");
    const { reply, done } = run({ personalBudget: { renderBudget, reward: vi.fn(), subsidiaryChoices: () => [] } });
    await done;
    expect(renderBudget).toHaveBeenCalledWith("111");
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("報酬分の残り: 300,000"),
      ephemeral: true,
      allowedMentions: { parse: [] },
    }));
  });

  it("keeps a long history within one Discord message", async () => {
    const { reply, done } = run({
      personalBudget: { renderBudget: () => "x".repeat(5_000), reward: vi.fn(), subsidiaryChoices: () => [] },
    });
    await done;
    const sent = (reply.mock.calls[0] as unknown[])[0] as { content: string };
    expect(sent.content.length).toBeLessThanOrEqual(1_900);
  });

  it("says so where the personal budget is not wired", async () => {
    const { reply, done } = run({});
    await done;
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, content: expect.stringContaining("使えません") }));
  });
});
