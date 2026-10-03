// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 月次予算の Discord のロールごとのコスト倍率の編集 (spec/feature/usage-budgets.md §3.1 §6)。
// API は vi.mock ではなく client で渡す (vitest のモジュール共有で、 他ファイルの api.js のモックに負けるため)。
const set = vi.fn(async () => ({}));
const remove = vi.fn(async () => ({ removed: true }));
const client = {
  usageBudgetRoleMultipliers: vi.fn(async () => ({
    multipliers: [
      { role_id: "10002", guild_id: "900001", multiplier: 0.5, updated_by: null, updated_at: 1 },
      { role_id: "10099", guild_id: "900001", multiplier: 0.8, updated_by: null, updated_at: 1 },
    ],
  })),
  usageBudgetDiscordRoles: vi.fn(async () => ({
    guilds: [{ guild_id: "900001", guild_name: "本社", roles: [{ id: "10001", name: "新入部員" }, { id: "10002", name: "メンター" }] }],
  })),
  usageBudgetRoleMultiplierSet: set,
  usageBudgetRoleMultiplierRemove: remove,
} as never;

const { BudgetRoleMultipliers } = await import("./BudgetRoleMultipliers.js");

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("BudgetRoleMultipliers", () => {
  it("guild のロールごとに倍率を出し、 入力を保存・空欄で外す", async () => {
    render(<BudgetRoleMultipliers client={client} />);
    const mentor = await screen.findByLabelText("本社 / メンターの予算のコスト倍率") as HTMLInputElement;
    expect(mentor.value).toBe("0.5");
    const newcomer = screen.getByLabelText("本社 / 新入部員の予算のコスト倍率") as HTMLInputElement;
    expect(newcomer.value).toBe("");
    fireEvent.change(newcomer, { target: { value: "0.5" } });
    fireEvent.blur(newcomer);
    await waitFor(() => expect(set).toHaveBeenCalledWith("10001", "900001", 0.5));
    fireEvent.change(mentor, { target: { value: "" } });
    fireEvent.blur(mentor);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("10002"));
  });

  it("一覧に無いロールの倍率も外せるように出す", async () => {
    render(<BudgetRoleMultipliers client={client} />);
    const unlisted = await screen.findByLabelText("ロール 10099の予算のコスト倍率") as HTMLInputElement;
    expect(unlisted.value).toBe("0.8");
  });

  it("範囲外の倍率は保存しない", async () => {
    render(<BudgetRoleMultipliers client={client} />);
    const newcomer = await screen.findByLabelText("本社 / 新入部員の予算のコスト倍率");
    fireEvent.change(newcomer, { target: { value: "0" } });
    fireEvent.blur(newcomer);
    expect(await screen.findByText("0 より大きく 10 以下")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });
});
