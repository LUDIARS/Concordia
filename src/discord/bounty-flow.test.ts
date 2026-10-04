import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  bountyAnnouncement,
  bountyErrorMessage,
  handleBountyModalSubmit,
  handleBountyName,
  handleBountyWithdraw,
  type BountyFlowDeps,
  type BountyReceiptView,
} from "./bounty-flow.js";
import { BOUNTY_REPORT_MODAL_ID } from "./bounty-modal.js";

const receipt: BountyReceiptView = {
  report_id: "br_abc", status: "received", project: "Cc", missing: [], reporter: "neco", has_recipient: true,
};
const WHAT = "スレッドが作られず、応答も返らない";

function setup(overrides: Partial<BountyFlowDeps> = {}) {
  const deps: BountyFlowDeps = {
    runtimeSubsidiaryId: null,
    submit: vi.fn(async () => ({ ok: true as const, receipt, created: true })),
    setPublicName: vi.fn(async () => ({ ok: true as const, display: "neco" })),
    withdraw: vi.fn(async () => ({ ok: true as const, receipt: { ...receipt, status: "withdrawn" } })),
    projects: () => [{ code: "Cc", project: "Concordia" }],
    currentPublicName: () => null,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return deps;
}

function modal(options: { sendFails?: boolean } = {}) {
  const values: Record<string, string> = { project: "Cc", what_happened: WHAT, repro_steps: "/spawn を実行する", public_name: "" };
  const replies: Array<{ content: string }> = [];
  const sent: Array<{ content: string; allowedMentions?: unknown }> = [];
  const interaction = {
    id: "1422334455",
    customId: BOUNTY_REPORT_MODAL_ID,
    guildId: "77777",
    channelId: "88888",
    user: { id: "905235114026467350" },
    fields: { getTextInputValue: (id: string) => values[id] ?? "" },
    channel: {
      send: vi.fn(async (message: { content: string }) => {
        if (options.sendFails) throw new Error("Missing Permissions");
        sent.push(message);
      }),
    },
    reply: vi.fn(async (message: { content: string }) => { replies.push(message); }),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async (message: { content: string }) => { replies.push(message); }),
  };
  return { interaction: interaction as unknown as ModalSubmitInteraction, raw: interaction, replies, sent };
}

function command(options: Record<string, string | null>) {
  const replies: Array<{ content: string; ephemeral?: boolean }> = [];
  const interaction = {
    user: { id: "905235114026467350" },
    options: {
      getString: (name: string, required?: boolean) => {
        const value = options[name] ?? null;
        if (required && value === null) throw new Error(`missing ${name}`);
        return value;
      },
    },
    reply: vi.fn(async (message: { content: string; ephemeral?: boolean }) => { replies.push(message); }),
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

describe("handleBountyModalSubmit (bug-bounty.md §3)", () => {
  it("submits with the interaction id as the idempotency key and answers only the reporter", async () => {
    const deps = setup();
    const { interaction, raw, replies, sent } = modal();
    await handleBountyModalSubmit(interaction, deps);
    expect(raw.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(deps.submit).toHaveBeenCalledWith({
      clientKey: "1422334455",
      userId: "905235114026467350",
      guildId: "77777",
      channelId: "88888",
      values: { project: "Cc", what_happened: WHAT, repro_steps: "/spawn を実行する", public_name: "" },
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain("br_abc");
    expect(replies[0]!.content).toContain("公開名: neco");
    // 告知は報告 id と対象プロジェクトだけ。 本文も報告者も出さない。
    expect(sent).toEqual([{ content: "バグ報告 `br_abc` を受け付けました (対象: Cc)。", allowedMentions: { parse: [] } }]);
    expect(sent[0]!.content).not.toContain(WHAT);
    expect(sent[0]!.content).not.toContain("neco");
  });

  it("does not announce a resend of an already received report", async () => {
    const deps = setup({ submit: vi.fn(async () => ({ ok: true as const, receipt, created: false })) });
    const { interaction, replies, sent } = modal();
    await handleBountyModalSubmit(interaction, deps);
    expect(replies[0]!.content).toContain("br_abc");
    expect(sent).toEqual([]);
  });

  it("keeps the report when the announcement cannot be delivered (CC-INV-06)", async () => {
    const deps = setup();
    const { interaction, replies } = modal({ sendFails: true });
    await handleBountyModalSubmit(interaction, deps);
    expect(replies[0]!.content).toContain("受け付けました");
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("bounty announcement failed report=br_abc"));
  });

  it("tells the reporter when no recipient could be identified", async () => {
    const deps = setup({
      submit: vi.fn(async () => ({ ok: true as const, receipt: { ...receipt, project: null, has_recipient: false }, created: true })),
    });
    const { interaction, replies, sent } = modal();
    await handleBountyModalSubmit(interaction, deps);
    expect(replies[0]!.content).toContain("受取人を特定できていません");
    expect(sent[0]!.content).toBe("バグ報告 `br_abc` を受け付けました (対象: 未特定)。");
  });

  it("returns the draft to the reporter alone when the report is refused, and logs no text", async () => {
    const deps = setup({ submit: vi.fn(async () => ({ ok: false as const, error: "unknown_project" })) });
    const { interaction, replies, sent } = modal();
    await handleBountyModalSubmit(interaction, deps);
    expect(replies[0]!.content).toContain("対象プロジェクトのコードが見つかりません");
    expect(replies[0]!.content).toContain(WHAT);
    expect(replies[0]!.content.length).toBeLessThanOrEqual(2000);
    expect(sent).toEqual([]);
    expect(JSON.stringify((deps.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(WHAT);
  });

  it("refuses a modal of another surface", async () => {
    const deps = setup();
    const { interaction, raw, replies } = modal();
    (raw as { customId: string }).customId = "bounty:modal:other";
    await handleBountyModalSubmit(interaction, deps);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({ ephemeral: true });
  });
});

describe("/bug name and /bug withdraw", () => {
  it("changes the caller's public name and returns to anonymous when omitted", async () => {
    const deps = setup();
    const named = command({ name: " neco " });
    await handleBountyName(named.interaction, deps);
    expect(deps.setPublicName).toHaveBeenCalledWith({ userId: "905235114026467350", publicName: "neco" });
    expect(named.replies[0]).toMatchObject({ content: "公開名を「neco」にしました。", ephemeral: true });

    const cleared = command({ name: null });
    await handleBountyName(cleared.interaction, deps);
    expect(deps.setPublicName).toHaveBeenLastCalledWith({ userId: "905235114026467350", publicName: null });
  });

  it("explains an invalid public name", async () => {
    const deps = setup({ setPublicName: vi.fn(async () => ({ ok: false as const, error: "public_name_invalid" })) });
    const { interaction, replies } = command({ name: "@everyone" });
    await handleBountyName(interaction, deps);
    expect(replies[0]).toMatchObject({ content: bountyErrorMessage("public_name_invalid"), ephemeral: true });
  });

  it("withdraws the caller's report and explains a refusal", async () => {
    const deps = setup();
    const ok = command({ id: " br_abc " });
    await handleBountyWithdraw(ok.interaction, deps);
    expect(deps.withdraw).toHaveBeenCalledWith({ reportId: "br_abc", userId: "905235114026467350" });
    expect(ok.replies[0]).toMatchObject({ content: "報告 `br_abc` を取り下げました。", ephemeral: true });

    const refused = setup({ withdraw: vi.fn(async () => ({ ok: false as const, error: "not_reporter" })) });
    const denied = command({ id: "br_abc" });
    await handleBountyWithdraw(denied.interaction, refused);
    expect(denied.replies[0]!.content).toBe("取り下げられるのは報告した本人だけです。");
  });
});

describe("messages", () => {
  it("announces only the report id and the project", () => {
    expect(bountyAnnouncement({ report_id: "br_1", project: null })).toBe("バグ報告 `br_1` を受け付けました (対象: 未特定)。");
  });

  it("falls back to a generic message for an unknown error code", () => {
    expect(bountyErrorMessage("fetch failed")).toContain("fetch failed");
  });
});
