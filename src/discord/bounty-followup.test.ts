import { describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import type { BountyFlowDeps } from "./bounty-flow.js";
import {
  BOUNTY_AMEND_MODAL_PREFIX,
  handleBountyAmendOpen,
  handleBountyAmendSubmit,
  handleBountyAppeal,
  handleBountyClose,
} from "./bounty-followup.js";

const REPORT = "br_0123456789abcdef";

function command(options: Record<string, string>) {
  const reply = vi.fn(async () => undefined);
  const showModal = vi.fn(async () => undefined);
  const interaction = {
    user: { id: "905235114026467350" },
    options: { getString: (name: string) => options[name] ?? null },
    reply,
    showModal,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, showModal };
}

function deps(overrides: Partial<BountyFlowDeps> = {}): BountyFlowDeps {
  return {
    runtimeSubsidiaryId: null,
    submit: vi.fn(), setPublicName: vi.fn(), withdraw: vi.fn(),
    amend: vi.fn(async () => ({ ok: true as const, receipt: { report_id: REPORT, status: "received", project: "Cc", missing: [], reporter: "匿名", has_recipient: false } })),
    appeal: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(async () => ({ ok: false as const, error: "not_authority" })),
    projects: () => [], currentPublicName: () => null,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

describe("/bug amend / appeal / close (bug-bounty.md §5 §7)", () => {
  it("opens the amend modal for a well-formed id and refuses a malformed one", async () => {
    const ok = command({ id: REPORT });
    await handleBountyAmendOpen(ok.interaction);
    expect(ok.showModal).toHaveBeenCalledTimes(1);
    const bad = command({ id: "../x" });
    await handleBountyAmendOpen(bad.interaction);
    expect(bad.showModal).not.toHaveBeenCalled();
    expect(bad.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("sends the amendment through the API and answers privately", async () => {
    const flow = deps();
    const editReply = vi.fn(async () => undefined);
    const modal = {
      customId: `${BOUNTY_AMEND_MODAL_PREFIX}${REPORT}`,
      user: { id: "905235114026467350" },
      fields: { getTextInputValue: (id: string) => (id === "what_happened" ? "書き足し" : "") },
      deferReply: vi.fn(async () => undefined),
      editReply,
      reply: vi.fn(async () => undefined),
    } as unknown as ModalSubmitInteraction;
    await handleBountyAmendSubmit(modal, flow);
    expect(flow.amend).toHaveBeenCalledWith({ reportId: REPORT, userId: "905235114026467350", whatHappened: "書き足し", reproSteps: "" });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
  });

  it("files an appeal and explains a refused close without mentioning anyone", async () => {
    const flow = deps();
    const appeal = command({ id: REPORT, reason: "再現します" });
    await handleBountyAppeal(appeal.interaction, flow);
    expect(flow.appeal).toHaveBeenCalledWith({ reportId: REPORT, userId: "905235114026467350", reason: "再現します" });
    const close = command({ id: REPORT, evidence: "反映を確認" });
    await handleBountyClose(close.interaction, flow);
    expect(close.reply).toHaveBeenCalledWith({ content: expect.stringContaining("本社の管理職以上"), ephemeral: true, allowedMentions: { parse: [] } });
  });
});
