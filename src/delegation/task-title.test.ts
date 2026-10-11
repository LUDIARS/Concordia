/** @implements spec/feature/task-workflow-v3.md — Actio task sync: title (CC-TF-SYNC-04) */

import { describe, expect, it } from "vitest";
import { deriveTaskTitle, summarizeTitle } from "./task-title.js";

describe("deriveTaskTitle", () => {
  it("uses the first sentence of the task argument instead of the template title", () => {
    expect(deriveTaskTitle({
      args: { task: "Ludellus-Server で MMO フィールド移動モックのサーバ側を実装する。設計は spec/x.md。\n詳細" },
      content: "テンプレート本文", fallback: "実装委託 (Opus 5.5)",
    })).toBe("Ludellus-Server で MMO フィールド移動モックのサーバ側を実装する。");
  });

  it("falls back to the first content line, then to the template title", () => {
    expect(deriveTaskTitle({ args: {}, content: "\n## 依頼\n本文", fallback: "実装委託" })).toBe("依頼");
    expect(deriveTaskTitle({ args: { task: "  " }, content: "", fallback: "実装委託" })).toBe("実装委託");
  });
});

describe("summarizeTitle", () => {
  it("does not split inside a file path and truncates long lines", () => {
    expect(summarizeTitle("spec/faq/actio-cc-task-project-sync.md を読む")).toBe("spec/faq/actio-cc-task-project-sync.md を読む");
    const long = "あ".repeat(100);
    expect([...summarizeTitle(long)]).toHaveLength(80);
    expect(summarizeTitle(long).endsWith("…")).toBe(true);
  });
});
