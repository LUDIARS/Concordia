import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { ConsultationPublicationRow } from "../db/consultation-publications-repo.js";
import {
  buildPublicationCard,
  decidedPublicationContent,
  handlePublicationButton,
  handlePublicationEditSubmit,
  MAX_EDITABLE_SUMMARY,
  parsePublicationButton,
  type PublicationInteractionDeps,
} from "./consult-publication.js";

function publication(patch: Partial<ConsultationPublicationRow> = {}): ConsultationPublicationRow {
  return {
    id: "cp_1", consultation_id: "pc_1", status: "proposed", title: "集約の切り方", summary: "不変条件の単位で切る",
    published_text: null, card_message_id: null, tabula_page_id: null, tabula_url: null, last_error: null,
    decided_by: null, decided_at: null, created_at: 1, updated_at: 1, ...patch,
  };
}

function buttons(card: ReturnType<typeof buildPublicationCard>) {
  return (card.components[0]!.toJSON().components as Array<{ custom_id: string; disabled?: boolean }>);
}

describe("publication card", () => {
  it("offers publish, edit, decline and withdraw on the proposal", () => {
    const card = buildPublicationCard(publication(), { tabulaReady: true });
    expect(card.content).toContain("集約の切り方");
    expect(buttons(card).map((b) => [b.custom_id, b.disabled ?? false])).toEqual([
      ["consult:pub:cp_1:publish", false],
      ["consult:pub:cp_1:edit", false],
      ["consult:pub:cp_1:decline", false],
      ["consult:pub:cp_1:withdraw", false],
    ]);
    expect(parsePublicationButton("consult:pub:cp_1:edit")).toEqual({ publicationId: "cp_1", action: "edit" });
    expect(parsePublicationButton("consult:pub:cp_1:delete")).toBeNull();
  });

  it("disables publishing without Tabula and editing for summaries too long for a modal", () => {
    const unset = buildPublicationCard(publication(), { tabulaReady: false });
    expect(unset.content).toContain("未設定");
    expect(buttons(unset).slice(0, 2).every((b) => b.disabled)).toBe(true);
    const long = buildPublicationCard(publication({ summary: "あ".repeat(MAX_EDITABLE_SUMMARY + 1) }), { tabulaReady: true });
    expect(buttons(long)[1]!.disabled).toBe(true);
    expect(long.content.length).toBeLessThanOrEqual(2_000);
  });

  it("describes the decided state with the Tabula link", () => {
    expect(decidedPublicationContent(publication({ status: "published", decided_by: "111", tabula_url: "https://tabula/#page=1" })))
      .toContain("https://tabula/#page=1");
  });
});

describe("publication interactions", () => {
  function deps(result: Awaited<ReturnType<PublicationInteractionDeps["decide"]>>): PublicationInteractionDeps {
    return {
      findPublication: (id) => (id === "cp_1" ? publication() : null),
      decide: vi.fn(async () => result),
      log: { info: vi.fn(), warn: vi.fn() },
    };
  }

  it("records a decision through the API and closes the card", async () => {
    const d = deps({ ok: true, publication: publication({ status: "declined", decided_by: "111" }) });
    const interaction = {
      customId: "consult:pub:cp_1:decline",
      user: { id: "111" },
      deferUpdate: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    await handlePublicationButton(interaction as unknown as ButtonInteraction, d);
    expect(d.decide).toHaveBeenCalledWith({ publicationId: "cp_1", decision: "decline", actorUserId: "111" });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });

  it("hands the decided publication to the closure after the card is closed (tech-consultation.md §7)", async () => {
    const decided = publication({ status: "declined", decided_by: "111" });
    const onDecided = vi.fn(async () => { throw new Error("delete failed"); });
    const d = { ...deps({ ok: true, publication: decided }), onDecided };
    const interaction = {
      customId: "consult:pub:cp_1:decline",
      user: { id: "111" },
      deferUpdate: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    await handlePublicationButton(interaction as unknown as ButtonInteraction, d);
    expect(onDecided).toHaveBeenCalledWith(decided);
    // 後始末の失敗は判断を取り消さず、 記録だけ残す。
    expect(d.log.warn).toHaveBeenCalled();
  });

  it("tells the presser privately when they may not decide", async () => {
    const d = deps({ ok: false, error: "not_requester" });
    const interaction = {
      customId: "consult:pub:cp_1:publish",
      user: { id: "900" },
      deferUpdate: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    await handlePublicationButton(interaction as unknown as ButtonInteraction, d);
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, content: expect.stringContaining("相談者本人") }));
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("opens the edit modal and publishes the edited text", async () => {
    const d = deps({ ok: true, publication: publication({ status: "published", tabula_url: "https://tabula/#page=1" }) });
    const showModal = vi.fn(async () => undefined);
    await handlePublicationButton({ customId: "consult:pub:cp_1:edit", user: { id: "111" }, showModal } as unknown as ButtonInteraction, d);
    expect(showModal).toHaveBeenCalledTimes(1);

    const messageEdit = vi.fn(async () => undefined);
    const modal = {
      customId: "consult:pubedit:cp_1",
      user: { id: "111" },
      fields: { getTextInputValue: () => "直した要約" },
      message: { edit: messageEdit },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
    await handlePublicationEditSubmit(modal as unknown as ModalSubmitInteraction, d);
    expect(d.decide).toHaveBeenCalledWith({ publicationId: "cp_1", decision: "publish", actorUserId: "111", editedSummary: "直した要約" });
    expect(messageEdit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
});
