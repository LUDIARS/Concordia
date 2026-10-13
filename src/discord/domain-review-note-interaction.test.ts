import type { StringSelectMenuInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { handleDomainReviewNoteInteraction } from "./domain-review-note-interaction.js";

function fakeInteraction(customId: string, values: string[]) {
  return {
    customId,
    values,
    member: null,
    user: { id: "42", globalName: "neco", username: "neco" },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

const log = { warn: () => undefined };

describe("handleDomainReviewNoteInteraction", () => {
  it("選択を backend へ渡し、ダイアログを外して結果を残す", async () => {
    const interaction = fakeInteraction("drn:7", ["*"]);
    const choose = vi.fn(async () => ({
      note_delivery: { status: "sent" as const, answer_id: 7, domain_id: null, proposal_id: "p-1" },
    }));

    await handleDomainReviewNoteInteraction(interaction as unknown as StringSelectMenuInteraction, choose, log);

    expect(choose).toHaveBeenCalledWith({ answerId: 7, actorId: "42", choice: "*" });
    expect(interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(choose.mock.invocationCallOrder[0]!);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });

  it("権限が無ければ押した本人にだけ理由を返し、ダイアログは残す", async () => {
    const interaction = fakeInteraction("drn:7", ["combat"]);
    await handleDomainReviewNoteInteraction(
      interaction as unknown as StringSelectMenuInteraction,
      async () => ({ error: "forbidden" }),
      log,
    );
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("返信した本人"),
    }));
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("読めない custom_id は backend を呼ばない", async () => {
    const interaction = fakeInteraction("drn:x", ["combat"]);
    const choose = vi.fn();
    await handleDomainReviewNoteInteraction(interaction as unknown as StringSelectMenuInteraction, choose, log);
    expect(choose).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalled();
  });
});
