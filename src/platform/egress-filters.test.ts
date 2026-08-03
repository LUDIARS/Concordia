import { describe, it, expect } from "vitest";
import { renderUnstructuredAskFallback, shouldDropForRelay } from "./egress-filters.js";

// @implements spec/feature/discord-lictor-relay.md — ask マーカーの fail-loud 中継

describe("egress-filters: shouldDropForRelay", () => {
  it("drops Codex guardian JSON ({risk_level, user_authorization, outcome})", () => {
    const guardianText = JSON.stringify({
      risk_level: "low",
      user_authorization: "high",
      outcome: "allow",
      rationale: "Read-only local code search for an explicitly requested change.",
    });
    expect(shouldDropForRelay(guardianText)).toBe(true);
  });

  it("drops guardian JSON with the canonical Codex key order", () => {
    // NOTE: 既知制約 — 正規表現はキーを "risk_level", "user_authorization", "outcome" の
    // 順序で固定マッチする。Codex は実際にこの順で serialize するため現状は問題ないが、
    // キー順序が変わると検出できなくなる。src の regex は本タスクでは直さない。
    const t = '{"risk_level":"low","user_authorization":"high","outcome":"allow"}';
    expect(shouldDropForRelay(t)).toBe(true);
  });

  it("keeps normal assistant text untouched", () => {
    expect(shouldDropForRelay("Sure, here is the patch you asked for.")).toBe(false);
    expect(shouldDropForRelay("```ts\nconst x = 1;\n```")).toBe(false);
  });

  it("keeps prose that happens to mention the words but isn't a JSON object", () => {
    // The predicate gates on `text.trimStart().startsWith("{")` so prose
    // mentioning the same words must not be dropped.
    const text =
      "I'll proceed with risk_level low and user_authorization high — outcome should be safe.";
    expect(shouldDropForRelay(text)).toBe(false);
  });

  it("keeps JSON that isn't the guardian shape", () => {
    expect(shouldDropForRelay('{"foo":"bar","baz":42}')).toBe(false);
    expect(shouldDropForRelay('{"risk_level":"low"}')).toBe(false); // partial match — missing other 2 keys
  });
});

describe("egress-filters: renderUnstructuredAskFallback", () => {
  it("keeps an ask-marker-only message with a fail-loud notice", () => {
    const text =
      '```ask\n{"question":"どっち?","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}\n```';
    const rendered = renderUnstructuredAskFallback(text);
    expect(rendered).toContain("質問カードを生成できませんでした");
    expect(rendered).toContain(text);
  });

  it("keeps both prose and the raw ask block", () => {
    const text =
      '進め方を確認します。\n\n```ask\n{"question":"どっち?","options":[{"label":"A"}]}\n```';
    const rendered = renderUnstructuredAskFallback(text);
    expect(rendered).toContain("進め方を確認します。");
    expect(rendered).toContain('"question":"どっち?"');
  });

  it("keeps multiple ask blocks in one message", () => {
    const text =
      '```ask\n{"question":"q1","options":[{"label":"A"}]}\n```\nつなぎ\n```ask\n{"question":"q2","options":[{"label":"B"}]}\n```';
    const rendered = renderUnstructuredAskFallback(text);
    expect(rendered).toContain('"question":"q1"');
    expect(rendered).toContain('"question":"q2"');
  });

  it("leaves normal text and non-ask code fences untouched", () => {
    expect(renderUnstructuredAskFallback("ふつうの本文です")).toBe("ふつうの本文です");
    const code = "```ts\nconst x = 1;\n```";
    expect(renderUnstructuredAskFallback(code)).toBe(code);
  });

  it("does not warn when the marker is only mentioned mid-line in prose", () => {
    const prose = "選択肢を出すときは ```ask フェンスを使ってください。";
    expect(renderUnstructuredAskFallback(prose)).toBe(prose);
  });
});
