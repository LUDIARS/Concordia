import { describe, it, expect } from "vitest";
import { requiresCompletionEvidence } from "./completion-evidence.js";

// 2026-09-02〜03 に quaestor-mail-sweep / kaizen-daily / deps-sweep-daily /
// vulnerability-response-daily の completed が
// "no completion evidence (spawned checkout has no recorded feature branch)" で
// failed へ落ちていた。 どれも本文が「commit も push も PR もしない」タスクである。
describe("requiresCompletionEvidence", () => {
  it("パートタイマーは feature branch を成果物として要求しない", () => {
    expect(requiresCompletionEvidence("parttimer")).toBe(false);
  });

  it("実装が成果になる雇用形態は引き続きガードする", () => {
    expect(requiresCompletionEvidence("employee")).toBe(true);
    expect(requiresCompletionEvidence("freelancer")).toBe(true);
    expect(requiresCompletionEvidence("test-qa")).toBe(true);
  });

  it("category 不明 (テンプレ削除済みの run) はガードする側に倒す", () => {
    expect(requiresCompletionEvidence(null)).toBe(true);
    expect(requiresCompletionEvidence(undefined)).toBe(true);
  });
});
