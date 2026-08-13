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

  it("command-pattern は作業マニュアル直後かつ固定の振る舞い説明より前に置く", () => {
    const ctx = buildDelegationContext(
      "http://127.0.0.1:11111",
      { kind: "実装", content: "manual" },
      "## コマンドパターン (Genius)\n\ncommand",
    );
    const manualIdx = ctx.indexOf("## 作業マニュアル");
    const patternIdx = ctx.indexOf("## コマンドパターン (Genius)");
    const behaviorIdx = ctx.indexOf("### 起動後の振る舞い");
    expect(patternIdx).toBeGreaterThan(manualIdx);
    expect(patternIdx).toBeLessThan(behaviorIdx);
  });

  it("空白のみの command-pattern は差し込まない", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111", null, "   ");
    expect(ctx).not.toContain("## コマンドパターン (Genius)");
  });

  it("Codex/Claude native child task を使わず Cc Delegation へ統一する契約を含む", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111");
    expect(ctx).toContain("Codex/Claude 固有の子エージェント起動機能は使いません");
    expect(ctx).toContain("`delegation_list_templates`");
    expect(ctx).toContain("`delegation_invoke`");
    expect(ctx).toContain("`spawn: true`");
    expect(ctx).toContain("`CONCORDIA_SESSION_ID`");
    expect(ctx).toContain("provider 固有 child を黙って代用せず");
  });

  it("言語ポリシー (会話=日本語 / 実装=英語可) を含む", () => {
    const ctx = buildDelegationContext("http://127.0.0.1:11111");
    expect(ctx).toContain("## 言語ポリシー (required)");
    expect(ctx).toContain("人間が読む出力は日本語で書きます");
    expect(ctx).toContain("実装内容は効率が良ければ英語で構いません");
    expect(ctx).toContain("spec/tasks/");
    expect(ctx).toContain("# タイトル、## 目的、## 完了条件を日本語で空欄なく設計");
  });

  // 段階注入 (spec/feature/delegation-staged-injection.md)。 approval と investigation は
  // 排他 — 併存させると委託先が矛盾を安全側に解釈して初回ターンで停止する。
  describe("posture", () => {
    it("既定 (approval) は従来どおり承認待ちの節を含む", () => {
      const ctx = buildDelegationContext("http://127.0.0.1:11111");
      expect(ctx).toContain("### 勝手に作業しない (重要)");
      expect(ctx).toContain("ユーザの承認を待ちます");
      expect(ctx).not.toContain("### まず調べる");
    });

    it("investigation では承認待ちの節が消え、調査姿勢に置き換わる", () => {
      const ctx = buildDelegationContext("http://127.0.0.1:11111", null, null, "investigation");
      expect(ctx).toContain("### まず調べる — 通常の不明点で停止しない (重要)");
      expect(ctx).not.toContain("### 勝手に作業しない (重要)");
      expect(ctx).not.toContain("ユーザの承認を待ちます");
    });

    it("investigation は停止してよい 2 条件だけを認める", () => {
      const ctx = buildDelegationContext("http://127.0.0.1:11111", null, null, "investigation");
      expect(ctx).toContain("外部権限が必要");
      expect(ctx).toContain("本当に不可逆な選択");
      expect(ctx).toContain("質問して停止しないでください");
    });

    it("posture を変えても status/inject プロトコルと言語ポリシーは残る", () => {
      const ctx = buildDelegationContext("http://127.0.0.1:11111", null, null, "investigation");
      expect(ctx).toContain("## Delegation status / inject protocol (required)");
      expect(ctx).toContain("## 言語ポリシー (required)");
    });
  });
});
