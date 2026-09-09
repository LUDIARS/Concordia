import type { Interaction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "./command-port.js";
import { dispatchQuestionInteraction } from "./question.js";

function closedQuestionDeps(): DiscordCommandDeps {
  return {
    pendingQuestionsRepo: {
      findById: () => ({ answered_at: null, closed_at: 100 }),
    },
  } as unknown as DiscordCommandDeps;
}

describe("closed Discord questions", () => {
  it.each([
    ["free-text button", "qoth:42"],
    ["answer button", "q:42:0"],
  ])("rejects a stale %s without opening or updating the card", async (_label, customId) => {
    const reply = vi.fn(async () => undefined);
    const showModal = vi.fn(async () => undefined);
    const deferUpdate = vi.fn(async () => undefined);
    const interaction = {
      customId,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      reply,
      showModal,
      deferUpdate,
    } as unknown as Interaction;

    await dispatchQuestionInteraction(interaction, closedQuestionDeps());

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(showModal).not.toHaveBeenCalled();
    expect(deferUpdate).not.toHaveBeenCalled();
  });

  it("rejects a stale free-text modal before deferring the answer", async () => {
    const reply = vi.fn(async () => undefined);
    const deferReply = vi.fn(async () => undefined);
    const interaction = {
      customId: "qothm:42",
      fields: { getTextInputValue: () => "late answer" },
      isButton: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      reply,
      deferReply,
    } as unknown as Interaction;

    await dispatchQuestionInteraction(interaction, closedQuestionDeps());

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(deferReply).not.toHaveBeenCalled();
  });
});
