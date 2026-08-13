import { describe, it, expect } from "vitest";
import { resolveManualKind } from "./manual-kind.js";

describe("resolveManualKind", () => {
  it("call_name に review を含む → レビュー", () => {
    expect(resolveManualKind({ call_name: "review-duo", title: "Review Duo" })).toBe("レビュー");
    expect(resolveManualKind({ call_name: "review-sonnet5", title: "x" })).toBe("レビュー");
    expect(resolveManualKind({ call_name: "ludiars-review-daily", title: "日次レビュー" })).toBe("レビュー");
  });

  it("title に レビュー を含む → レビュー (大文字小文字を無視)", () => {
    expect(resolveManualKind({ call_name: "opus-check", title: "コードレビュー突合" })).toBe("レビュー");
    expect(resolveManualKind({ call_name: "REVIEW-full", title: "x" })).toBe("レビュー");
  });

  it("design / 設計 → 設計相談", () => {
    expect(resolveManualKind({ call_name: "design-hard-fable5", title: "Design Hard" })).toBe("設計相談");
    expect(resolveManualKind({ call_name: "design-analysis-opus", title: "設計分析" })).toBe("設計相談");
    expect(resolveManualKind({ call_name: "opus-plan", title: "設計相談" })).toBe("設計相談");
  });

  it("test / テスト → テスト", () => {
    expect(resolveManualKind({ call_name: "run-e2e", title: "Test runner" })).toBe("テスト");
    expect(resolveManualKind({ call_name: "confirm", title: "動作テスト確認" })).toBe("テスト");
  });

  it("実装系 (employee / impl / fix / refactor) → 実装", () => {
    expect(resolveManualKind({ call_name: "fix-bug", title: "バグ修正" })).toBe("実装");
    expect(resolveManualKind({ call_name: "refactor", title: "リファクタ" })).toBe("実装");
    expect(resolveManualKind({ call_name: "claude-high-impl", title: "Claude Impl" })).toBe("実装");
  });

  it("ヒント無しの既定は 実装", () => {
    expect(resolveManualKind({ call_name: "codex-5-6-sol", title: "Codex Sol" })).toBe("実装");
    expect(resolveManualKind({ call_name: "morning-tasks", title: "朝のタスク" })).toBe("実装");
  });

  it("実装系キーワードは design / review より優先される (impl-from-design / autofix)", () => {
    expect(resolveManualKind({ call_name: "impl-from-design", title: "設計から実装" })).toBe("実装");
    expect(resolveManualKind({ call_name: "daily-review-autofix", title: "レビュー AUTOFIX 適用" })).toBe("実装");
  });

  it("実装系キーワードを含まない design-review はレビュー", () => {
    expect(resolveManualKind({ call_name: "design-review", title: "設計レビュー" })).toBe("レビュー");
  });
});
