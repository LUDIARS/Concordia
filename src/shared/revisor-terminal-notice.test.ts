import { describe, expect, it } from "vitest";
import { revisorTerminalKind, withRevisorContinuation } from "./revisor-terminal-notice.js";

const notices = [
  ["merged", "✅ Revisor レビュー完了: LUDIARS/Concordia#42 は Test OK で自動マージされました。"],
  ["failed", "⚠️ Revisor レビュー失敗: LUDIARS/Concordia#42 は審査を完了できませんでした。"],
  ["action_required", "🔴 Revisor レビュー完了: LUDIARS/Concordia#42 はマージできません。"],
] as const;

describe("Revisor terminal continuation policy", () => {
  it.each(notices)("recognizes %s and preserves the original evidence", (kind, text) => {
    const evidence = `${text}\r\n理由: review evidence`;
    expect(revisorTerminalKind("revisor", evidence)).toBe(kind);
    const enriched = withRevisorContinuation("revisor", evidence);
    expect(enriched.startsWith(evidence)).toBe(true);
    expect(enriched).toContain("Actio");
    expect(enriched).toContain(kind === "merged" ? "反映状態" : "再審査");
    expect(enriched).toContain("新たな実行許可ではありません");
    expect(enriched).toContain("人間判断待ち");
    expect(withRevisorContinuation("revisor", enriched)).toBe(enriched);
  });

  it.each(["manual", "discord:123", "revisor-other", null])("does not enrich another source: %s", source => {
    expect(revisorTerminalKind(source, notices[0][1])).toBeNull();
    expect(withRevisorContinuation(source, notices[0][1])).toBe(notices[0][1]);
  });

  it.each([
    "✅ Revisor レビュー完了: LUDIARS/Concordia#42 は Open / Test OK です (マージ可能)。",
    "Revisor 再審査を開始しました。",
    `引用:\n${notices[0][1]}`,
    "unknown outcome",
  ])("does not infer a terminal outcome from %s", text => {
    expect(revisorTerminalKind("revisor", text)).toBeNull();
    expect(withRevisorContinuation("revisor", text)).toBe(text);
  });
});
