import { describe, expect, it } from "vitest";
import {
  confinementArgsFor,
  consultEffortOptions,
  consultModelForRole,
  consultTemplateFor,
} from "./consult-model.js";

describe("consultModelForRole", () => {
  it("デザイナー・サウンドは Astra", () => {
    for (const role of ["デザイナー", "UI デザイナー", "サウンドクリエイター", "コンポーザー", "Sound designer", "アートディレクター"]) {
      expect(consultModelForRole(role)).toBe("astra");
    }
  });

  it("エンジニア・企画・不明は Opus", () => {
    for (const role of ["エンジニア", "プログラマー", "企画", "プランナー", "学生", "", null]) {
      expect(consultModelForRole(role)).toBe("opus");
    }
  });
});

describe("consultTemplateFor / consultEffortOptions", () => {
  it("既定のテンプレートと env での差し替え", () => {
    expect(consultTemplateFor("opus", {})).toBe("opus-5-5-movable");
    expect(consultTemplateFor("astra", {})).toBe("astra-mid");
    expect(consultTemplateFor("astra", { CONCORDIA_CONSULT_ASTRA_TEMPLATE: "astra-x" })).toBe("astra-x");
  });

  it("effort は medium を provider の形で渡す", () => {
    expect(consultEffortOptions("claude")).toEqual({ effort: "medium" });
    expect(consultEffortOptions("codex")).toEqual({ model_reasoning_effort: "medium" });
  });
});

describe("confinementArgsFor", () => {
  it("claude は渡された引数、 codex はシェル・プラグイン・MCP を外して上位の AGENTS.md を探さない、 それ以外は起動しない", () => {
    expect(confinementArgsFor("claude", ["--tools=WebSearch"])).toEqual(["--tools=WebSearch"]);
    expect(confinementArgsFor("codex", [])).toEqual([
      "-p", "consult", "-s", "read-only", "--disable", "shell_tool", "--disable", "plugins", "-c", "project_root_markers=[]", "-c", "mcp_servers={}",
    ]);
    expect(confinementArgsFor("gemini", [])).toBeNull();
  });
});
