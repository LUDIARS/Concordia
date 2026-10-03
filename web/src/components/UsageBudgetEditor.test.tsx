// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const usageBudgetSet = vi.fn(async () => ({ budget: {} }));
const usageBudgetRemove = vi.fn(async () => ({ removed: true }));
// API は vi.mock ではなく client で渡す (vitest のモジュール共有で、 他ファイルの api.js のモックに負けるため)。
const client = { usageBudgetSet, usageBudgetRemove } as never;

const { UsageBudgetEditor } = await import("./UsageBudgetEditor.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const budget = {
  scope: "user" as const, target_id: "111", limit_tokens: 1_000, consumed_tokens: 850, ratio: 0.85, exhausted: false, updated_at: 1,
};

describe("UsageBudgetEditor", () => {
  it("今月の消費と割合を表示し、 値を変えて離れると保存する", async () => {
    const onChanged = vi.fn();
    render(<UsageBudgetEditor scope="user" targetId="111" budget={budget} onChanged={onChanged} client={client} />);
    expect(screen.getByText("今月 850 (85%)")).toBeTruthy();
    const input = screen.getByPlaceholderText("無制限");
    await userEvent.clear(input);
    await userEvent.type(input, "2000");
    await userEvent.tab();
    expect(usageBudgetSet).toHaveBeenCalledWith("user", "111", 2000);
    expect(onChanged).toHaveBeenCalled();
  });

  it("空欄で離れると予算を外す (無制限)", async () => {
    render(<UsageBudgetEditor scope="team" targetId="team_a" budget={{ ...budget, scope: "team", target_id: "team_a" }} onChanged={vi.fn()} client={client} />);
    await userEvent.clear(screen.getByPlaceholderText("無制限"));
    await userEvent.tab();
    expect(usageBudgetRemove).toHaveBeenCalledWith("team", "team_a");
  });

  it("整数でない値は保存しない", async () => {
    render(<UsageBudgetEditor scope="user" targetId="111" budget={null} onChanged={vi.fn()} client={client} />);
    await userEvent.type(screen.getByPlaceholderText("無制限"), "abc");
    await userEvent.tab();
    expect(usageBudgetSet).not.toHaveBeenCalled();
    expect(screen.getByText("0 以上の整数で入力してください")).toBeTruthy();
  });
});
