// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// 月次予算の設定欄が社員名簿とチームのコスト画面に出ること (spec/feature/usage-budgets.md §6)。
const budgets = [
  { scope: "user", target_id: "111", limit_tokens: 1_000, consumed_tokens: 1_000, ratio: 1, exhausted: true, updated_at: 1 },
  { scope: "team", target_id: "team_a", limit_tokens: 4_000, consumed_tokens: 1_000, ratio: 0.25, exhausted: false, updated_at: 1 },
];
vi.mock("../api.js", () => ({
  fmtTs: () => "-",
  api: {
    staffList: vi.fn(async () => ({
      members: [{ platform: "discord", platform_user_id: "111", display_name: "neco", profile_name: null, role: "executive", note: "", last_seen_at: 1 }],
      counts: { discord: { staff: 0, manager: 0, executive: 1 }, slack: { staff: 0, manager: 0, executive: 0 } },
      has_executive: true,
    })),
    usageBudgets: vi.fn(async () => ({ budgets })),
    teamCost: vi.fn(async () => ({ points: [] })),
    usageBudgetSet: vi.fn(),
    usageBudgetRemove: vi.fn(),
  },
}));
vi.mock("./staff/StaffAddForm.js", () => ({ StaffAddForm: () => null }));
vi.mock("./staff/StaffRoleLegend.js", () => ({ StaffRoleLegend: () => null }));

const { Staff } = await import("./Staff.js");
const { TeamCost } = await import("./teams/TeamCost.js");

afterEach(() => cleanup());

describe("月次予算の設定欄", () => {
  it("社員名簿の Discord の人に今月の消費を出す", async () => {
    render(<Staff />);
    expect(await screen.findByText("月の予算 (トークン)")).toBeTruthy();
    expect(await screen.findByText("今月 1,000 (100%)")).toBeTruthy();
  });

  it("チームのコスト画面にチームの予算を出す", async () => {
    render(<TeamCost teamId="team_a" />);
    expect(await screen.findByText("今月 1,000 (25%)")).toBeTruthy();
  });
});
