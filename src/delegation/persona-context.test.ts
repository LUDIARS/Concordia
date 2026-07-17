import { describe, it, expect } from "vitest";
import { buildDelegationContext } from "./persona-context.js";

describe("buildDelegationContext", () => {
  it("manual なしでは作業マニュアル節を含まない", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111");
    expect(ctx).toContain("## Concordia コンテキスト");
    expect(ctx).not.toContain("## 作業マニュアル");
  });

  it("manual を渡すと kind 付きの作業マニュアル節が差し込まれる", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111", {
      kind: "レビュー",
      content: "worktree の生成・ブランチ切り替えは不要。",
    });
    expect(ctx).toContain("## 作業マニュアル (kind: レビュー)");
    expect(ctx).toContain("worktree の生成・ブランチ切り替えは不要。");
  });

  it("作業マニュアル節は協調コンテキストの先頭付近 (固定文言より前) に置かれる", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111", {
      kind: "実装",
      content: "作業ブランチを確定 → worktree を生成。",
    });
    const manualIdx = ctx.indexOf("## 作業マニュアル");
    const behaviorIdx = ctx.indexOf("### 起動後の振る舞い");
    const protocolIdx = ctx.indexOf("## Delegation status / inject protocol");
    expect(manualIdx).toBeGreaterThan(-1);
    expect(manualIdx).toBeLessThan(behaviorIdx);
    expect(manualIdx).toBeLessThan(protocolIdx);
  });

  it("content が空白のみの manual は差し込まない", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111", { kind: "雑用", content: "   " });
    expect(ctx).not.toContain("## 作業マニュアル");
  });

  it("null manual は差し込まない (従来互換)", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111", null);
    expect(ctx).not.toContain("## 作業マニュアル");
  });
});
