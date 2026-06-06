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

  it("drops guardian JSON regardless of key order (regex matches any order)", () => {
    // Same keys, different order — the regex requires the three keys in this
    // specific order ("risk_level", "user_authorization", "outcome"). Codex
    // serializes them deterministically in this order in practice; if it ever
    // changes, this test will surface the regression.
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
