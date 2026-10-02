import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import {
  BUDGET_RESUME_PREFIX,
  budgetResumeMessage,
  budgetResumeReplyText,
  deliverBudgetResumable,
  handleBudgetResumeButton,
} from "./budget-resume.js";

describe("budgetResumeMessage", () => {
  it("セッションを指す「再開」ボタンを付け、 メンションしない", () => {
    const message = budgetResumeMessage("lictor-1", "予算が戻りました。");
    expect(message.content).toContain("予算が戻りました。");
    expect(message.allowedMentions).toEqual({ parse: [] });
    const button = message.components[0]!.toJSON().components[0] as { custom_id: string; label: string };
    expect(button).toMatchObject({ custom_id: `${BUDGET_RESUME_PREFIX}lictor-1`, label: "再開" });
  });
});

describe("handleBudgetResumeButton", () => {
  function interaction(customId: string) {
    return {
      customId,
      user: { id: "222222222" },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as unknown as ButtonInteraction & { editReply: ReturnType<typeof vi.fn> };
  }

  it("押した人を Concordia の再開 API へ渡し、 結果を本人にだけ返す", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "resume_not_allowed" }), { status: 403 }));
    const i = interaction(`${BUDGET_RESUME_PREFIX}lictor-1`);
    await handleBudgetResumeButton(i, { concordiaUrl: "http://cc/", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith("http://cc/v1/usage-budgets/suspensions/lictor-1/resume", expect.objectContaining({
      method: "POST", body: JSON.stringify({ actor_user_id: "222222222" }),
    }));
    expect(i.editReply).toHaveBeenCalledWith({ content: budgetResumeReplyText(false, "resume_not_allowed") });
    expect(budgetResumeReplyText(false, "resume_not_allowed")).toContain("起動した人");
    expect(budgetResumeReplyText(true, null)).toContain("再開しました");
  });
});

describe("deliverBudgetResumable", () => {
  it("セッションのスレッドへ出し、 スレッドが無ければ出さない", async () => {
    const send = vi.fn(async () => {});
    const warn = vi.fn();
    await deliverBudgetResumable({ channelIdForSession: () => "thread-1", send, log: { warn } }, { session_id: "s1", text: "戻りました" });
    expect(send).toHaveBeenCalledWith("thread-1", expect.objectContaining({ content: "💰 戻りました" }));
    await deliverBudgetResumable({ channelIdForSession: () => null, send, log: { warn } }, { session_id: "s2", text: "x" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});
