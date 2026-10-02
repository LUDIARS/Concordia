// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 月次予算の役職ごとのコスト倍率の編集 (spec/feature/usage-budgets.md §3.1 §6)。
// API は vi.mock ではなく client で渡す (vitest のモジュール共有で、 他ファイルの api.js のモックに負けるため)。
const set = vi.fn(async () => ({}));
const remove = vi.fn(async () => ({ removed: true }));
const client = {
  usageBudgetRoleMultipliers: vi.fn(async () => ({ multipliers: [{ role: "manager", multiplier: 0.5, updated_by: null, updated_at: 1 }] })),
  usageBudgetRoleMultiplierSet: set,
  usageBudgetRoleMultiplierRemove: remove,
} as never;

const { BudgetRoleMultipliers } = await import("./BudgetRoleMultipliers.js");

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("BudgetRoleMultipliers", () => {
  it("役職ごとの倍率を出し、 入力を保存・空欄で外す", async () => {
    render(<BudgetRoleMultipliers client={client} />);
    const manager = await screen.findByLabelText("管理職の予算のコスト倍率") as HTMLInputElement;
    expect(manager.value).toBe("0.5");
    const staff = screen.getByLabelText("ヒラ社員の予算のコスト倍率") as HTMLInputElement;
    fireEvent.change(staff, { target: { value: "2" } });
    fireEvent.blur(staff);
    await waitFor(() => expect(set).toHaveBeenCalledWith("staff", 2));
    fireEvent.change(manager, { target: { value: "" } });
    fireEvent.blur(manager);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("manager"));
  });

  it("範囲外の倍率は保存しない", async () => {
    render(<BudgetRoleMultipliers client={client} />);
    const staff = await screen.findByLabelText("ヒラ社員の予算のコスト倍率");
    fireEvent.change(staff, { target: { value: "0" } });
    fireEvent.blur(staff);
    expect(await screen.findByText("0 より大きく 10 以下")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });
});
