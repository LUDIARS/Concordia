import { describe, it, expect } from "vitest";
import {
  buildInitialWorkInjectText,
  INITIAL_WORK_INJECT_SOURCE,
  type InitialWorkTarget,
} from "./initial-work.js";

function target(over: Partial<InitialWorkTarget> = {}): InitialWorkTarget {
  return { repo: "Anatomia", branch: "main", raw: "Anatomia: main", ...over };
}

describe("INITIAL_WORK_INJECT_SOURCE", () => {
  it("is a control source (not a discord:/slack: human inject)", () => {
    expect(INITIAL_WORK_INJECT_SOURCE).toBe("auto:initial-work");
    expect(/^(discord|slack):/.test(INITIAL_WORK_INJECT_SOURCE)).toBe(false);
  });
});

describe("buildInitialWorkInjectText", () => {
  it("names the selected repo + branch and instructs fetch → list → ask", () => {
    const text = buildInitialWorkInjectText(target());
    expect(text).toContain("「Anatomia / main」");
    expect(text).toContain("残タスク");
    // 実行可否をユーザに問い合わせる流れを明示している
    expect(text).toContain("問い合わせて");
  });

  it("forbids the AskUserQuestion picker (count is unknown → free text)", () => {
    const text = buildInitialWorkInjectText(target());
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("自由文");
  });

  it("degrades gracefully when branch is blank", () => {
    const text = buildInitialWorkInjectText(target({ branch: "" }));
    expect(text).toContain("「Anatomia」");
    expect(text).not.toContain(" / 」");
  });

  it("falls back to a placeholder when repo is blank", () => {
    const text = buildInitialWorkInjectText(target({ repo: "  ", branch: "" }));
    expect(text).toContain("選択したリポジトリ");
  });
});
