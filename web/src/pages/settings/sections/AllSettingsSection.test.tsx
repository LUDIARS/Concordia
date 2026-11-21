// @vitest-environment jsdom
// 「すべての設定」で secret (AI プレイテスト受け口の鍵) を保存する操作面。
// 入力条件に合わない値は欄のそばで分かること、 拒否はその項目に理由が出ること、
// 保存できたら 「設定済み」 に変わり保存完了が見えることを押さえる (値は画面へ読み返さない)。
// @implements spec/feature/playtest-review-notify.md — 認証
import { afterEach, describe, expect, it, vi } from "vitest";
// jest-dom の matcher は root vitest 実行では expect に載らないので、素の matcher だけで書く。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SettingItem, SettingsSectionPayload, SettingsUpdateOutcome } from "../../../api.js";
import { AllSettingsSection, type AllSettingsClient } from "./AllSettingsSection.js";
import { draftProblem } from "./settingDraftCheck.js";

const KEY = "playtest_notify.intake_token";
/** テスト値 (実物ではない)。 */
const TOKEN = "t".repeat(40);

function intakeToken(set: boolean): SettingItem {
  return {
    key: KEY,
    section: "playtest-notify",
    label: "AI プレイテスト受け口の鍵",
    description: "受け口専用の鍵",
    kind: "secret",
    envName: null,
    dbKey: KEY,
    defaultValue: null,
    editable: true,
    stringPattern: "^\\S{32,}$",
    stringPatternDescription: "空白を含まない 32 文字以上",
    value: null,
    set,
    source: set ? "db" : "none",
  };
}

function sections(set: boolean): SettingsSectionPayload[] {
  return [{ id: "playtest-notify", label: "AI プレイテスト通知", description: "", settings: [intakeToken(set)] }];
}

function makeClient(outcome: SettingsUpdateOutcome) {
  return {
    allSettings: vi.fn(async () => ({ sections: sections(false) })),
    updateSettings: vi.fn(async (_updates: Record<string, unknown>) => outcome),
  } satisfies AllSettingsClient;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("draftProblem", () => {
  it("入力条件に合わない下書きだけ案内を返し、 値そのものは含めない", () => {
    const setting = intakeToken(false);
    expect(draftProblem(setting, undefined)).toBeNull();
    expect(draftProblem(setting, TOKEN)).toBeNull();
    const problem = draftProblem(setting, "short-value");
    expect(problem).toContain("空白を含まない 32 文字以上");
    expect(problem).not.toContain("short-value");
    expect(draftProblem({ stringPattern: undefined }, "anything")).toBeNull();
  });
});

describe("AllSettingsSection", () => {
  it("32 文字以上の鍵を保存すると、 その鍵だけを送り 「設定済み」 と保存完了を出す", async () => {
    const client = makeClient({ ok: true, sections: sections(true) });
    render(<AllSettingsSection client={client} />);
    const input = await screen.findByPlaceholderText("新しい値を入力");
    expect(screen.getByText("入力条件: 空白を含まない 32 文字以上")).toBeTruthy();

    await userEvent.type(input, TOKEN);
    expect(screen.getByText("未保存")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "保存 (1)" }));

    await waitFor(() => expect(client.updateSettings).toHaveBeenCalledWith({ [KEY]: TOKEN }));
    expect(await screen.findByText("1 件を保存しました")).toBeTruthy();
    expect(screen.getByText("現在: 設定済み (値は表示しません)")).toBeTruthy();
    expect(screen.queryByText("未保存")).toBeNull();
    expect((screen.getByPlaceholderText("新しい値を入力") as HTMLInputElement).value).toBe("");
  });

  it("短い鍵は欄のそばで保存できないと分かり、 サーバの拒否理由もその項目に出す", async () => {
    const client = makeClient({
      ok: false,
      rejected: [{ code: "invalid_value", key: KEY, detail: "空白を含まない 32 文字以上" }],
    });
    render(<AllSettingsSection client={client} />);
    const input = await screen.findByPlaceholderText("新しい値を入力");

    await userEvent.type(input, "short-value");
    expect(screen.getByRole("alert").textContent).toContain("入力条件に合わないため保存できません");
    await userEvent.click(screen.getByRole("button", { name: "保存 (1)" }));

    expect(await screen.findByText("保存できませんでした: invalid_value (空白を含まない 32 文字以上)")).toBeTruthy();
    expect(screen.getByText(/保存できませんでした \(何も保存していません\)/)).toBeTruthy();
    expect(screen.getByText("現在: 未設定")).toBeTruthy();
    expect(screen.getByText("未保存")).toBeTruthy();
  });
});
