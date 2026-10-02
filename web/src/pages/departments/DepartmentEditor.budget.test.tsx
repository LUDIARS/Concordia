// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 部署の月次予算のコスト倍率 (spec/feature/departments.md §5、 usage-budgets.md §3.1)。
// API は vi.mock ではなく client で渡す (vitest のモジュール共有で、 他ファイルの api.js のモックに負けるため)。
const update = vi.fn(async (_id: string, body: unknown) => ({ department: { ...department, ...(body as object) } }));
const client = { departmentUpdate: update } as never;

const department = {
  id: "dept-qa", subsidiary_id: null, name: "技術相談課", slug: "qa", description: "",
  settings: {
    launch: { provider: "claude" }, projects: [],
    output: { thinking: "inherit", status_card: "inherit", session_info_card: "inherit", cost_report: "inherit" },
    budget: { cost_multiplier: 0.25 },
  },
  settings_error: null, rules_text: "", sort_order: 0, use_case_id: null, is_default: false,
  discord_forum_id: null, archived: false, archived_at: null,
};

const { DepartmentEditor } = await import("./DepartmentEditor.js");

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("DepartmentEditor — 予算のコスト倍率", () => {
  it("保存済みの倍率を出し、 変更を部署設定へ保存する", async () => {
    render(<DepartmentEditor department={department as never} useCases={[]} onSaved={() => {}} client={client} />);
    const input = screen.getByLabelText("予算のコスト倍率") as HTMLInputElement;
    expect(input.value).toBe("0.25");
    fireEvent.change(input, { target: { value: "0.5" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![1]).toMatchObject({ settings: { budget: { cost_multiplier: 0.5 } } });
  });

  it("範囲外の倍率は保存しない", async () => {
    render(<DepartmentEditor department={department as never} useCases={[]} onSaved={() => {}} client={client} />);
    fireEvent.change(screen.getByLabelText("予算のコスト倍率"), { target: { value: "0" } });
    fireEvent.click(screen.getByText("保存"));
    expect(await screen.findByText("予算のコスト倍率は 0 より大きく 10 以下で入力してください")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });
  it("画面に項目の無い設定 (初回だけの注入・自動確認) を保存で落とさない", async () => {
    const consult = { ...department, settings: { ...department.settings, startup_inject: "initial-only", auto_check: "off" } };
    render(<DepartmentEditor department={consult as never} useCases={[]} onSaved={() => {}} client={client} />);
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![1]).toMatchObject({ settings: { startup_inject: "initial-only", auto_check: "off" } });
  });
});
