import { describe, expect, it } from "vitest";
import { FETCH_LINK_SCRIPT_ENV, isAllowedFetchLinkCommand } from "../../tools/consult-fetch-link-command.mjs";
import { CONSULT_FETCH_LINK_SCRIPT_ENV, consultClaudePermissions, consultFetchLinkScript } from "./consult-fetch-link.js";

describe("consult fetch-link", () => {
  it("取得スクリプトは相談フォルダの _source/tools/fetch-link (前方スラッシュ)", () => {
    expect(consultFetchLinkScript("E:\\Document\\Consult")).toBe("E:/Document/Consult/_source/tools/fetch-link/fetch-link.mjs");
  });

  it("claude の許可は Web 検索・ToDo・スキルと取得コマンドだけ、 ほかは聞かずに拒否", () => {
    expect(consultClaudePermissions("E:/Document/Consult")).toEqual({
      defaultMode: "dontAsk",
      allow: ["WebSearch", "TodoWrite", "Skill", "Bash(node E:/Document/Consult/_source/tools/fetch-link/fetch-link.mjs:*)"],
    });
  });

  it("起動 env の名前は codex のフックと同じで、 フックはこのスクリプトの形を通す", () => {
    expect(CONSULT_FETCH_LINK_SCRIPT_ENV).toBe(FETCH_LINK_SCRIPT_ENV);
    const script = consultFetchLinkScript("E:/Document/Consult");
    expect(isAllowedFetchLinkCommand(`node ${script} 'https://www.notion.so/Page-0123'`, script)).toBe(true);
  });
});
