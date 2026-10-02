import { describe, expect, it, vi } from "vitest";
import { budgetRefusalText, deliverUsageBudgetNotice, type UsageBudgetNoticeDeps } from "./usage-budget-notice.js";

function deps(patch: Partial<UsageBudgetNoticeDeps> = {}): UsageBudgetNoticeDeps {
  return {
    isHeadOffice: true,
    sendDirectMessage: vi.fn(async () => undefined),
    teamCostChannelId: vi.fn(() => "cost-ch"),
    sendToChannel: vi.fn(async () => undefined),
    log: { warn: vi.fn() },
    ...patch,
  };
}

describe("deliverUsageBudgetNotice", () => {
  it("DMs the user only from the head-office bot", async () => {
    const head = deps();
    await deliverUsageBudgetNotice(head, { scope: "user", target_id: "111", text: "80%" });
    expect(head.sendDirectMessage).toHaveBeenCalledWith("111", "💰 80%");
    const sub = deps({ isHeadOffice: false });
    await deliverUsageBudgetNotice(sub, { scope: "user", target_id: "111", text: "80%" });
    expect(sub.sendDirectMessage).not.toHaveBeenCalled();
  });

  it("posts a team notice to the team's cost surface owned by this bot", async () => {
    const d = deps();
    await deliverUsageBudgetNotice(d, { scope: "team", target_id: "team_a", text: "100%" });
    expect(d.sendToChannel).toHaveBeenCalledWith("cost-ch", "💰 100%");
    const none = deps({ teamCostChannelId: () => null });
    await deliverUsageBudgetNotice(none, { scope: "team", target_id: "team_x", text: "100%" });
    expect(none.sendToChannel).not.toHaveBeenCalled();
  });

  it("logs a failed delivery without throwing", async () => {
    const d = deps({ sendDirectMessage: vi.fn(async () => { throw new Error("DM closed"); }) });
    await deliverUsageBudgetNotice(d, { scope: "user", target_id: "111", text: "x" });
    expect(d.log.warn).toHaveBeenCalled();
  });
});

describe("budgetRefusalText", () => {
  it("extracts the refusal text from the admin spawn error", () => {
    expect(budgetRefusalText("budget_exhausted: あなたの今月の予算を使い切りました")).toBe("あなたの今月の予算を使い切りました");
    expect(budgetRefusalText("session spawn failed")).toBeNull();
  });
});
