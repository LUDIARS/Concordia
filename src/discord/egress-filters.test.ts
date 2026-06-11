import { describe, it, expect } from "vitest";
import { shouldDropForRelay, stripAskMarkerBlocks } from "./egress-filters.js";

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

describe("egress-filters: stripAskMarkerBlocks", () => {
  it("removes an ask-marker-only message (Question JSON) entirely", () => {
    const text =
      '```ask\n{"question":"どっち?","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}\n```';
    expect(stripAskMarkerBlocks(text)).toBe("");
  });

  it("keeps prose around the ask block but drops the JSON block", () => {
    const text =
      '進め方を確認します。\n\n```ask\n{"question":"どっち?","options":[{"label":"A"}]}\n```';
    expect(stripAskMarkerBlocks(text)).toBe("進め方を確認します。");
  });

  it("removes multiple ask blocks in one message", () => {
    const text =
      '```ask\n{"question":"q1","options":[{"label":"A"}]}\n```\nつなぎ\n```ask\n{"question":"q2","options":[{"label":"B"}]}\n```';
    expect(stripAskMarkerBlocks(text)).toBe("つなぎ");
  });

  it("leaves normal text and non-ask code fences untouched", () => {
    expect(stripAskMarkerBlocks("ふつうの本文です")).toBe("ふつうの本文です");
    const code = "```ts\nconst x = 1;\n```";
    expect(stripAskMarkerBlocks(code)).toBe(code);
  });
});
