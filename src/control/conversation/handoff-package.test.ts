import { describe, expect, it } from "vitest";
import { packageHoldReasons, parseHandoffPackage, renderHandoffBrief } from "./handoff-package.js";

const valid = {
  summary: "Sidecar の起動ガードまで実装した",
  decisions: [{ decision: "migration 114 を追加", reason: "会話と交代の永続化" }],
  repo_path: "E:/Document/Ars/Concordia-feat-x",
  branch: "feat/x",
  outputs: ["commit abc1234"],
  remaining: ["テスト追加"],
  authorization_scope: "テスト実行・merge は未許可",
  human_waits: [],
  external_operations: [{ kind: "pr_submit", correlation_id: "local-pr-1", state: "confirmed" }],
  task_references: ["actio:2261f19a"],
  references: ["spec/feature/astra-with-sidecar.md@108b43bd"],
};

describe("handoff package", () => {
  it("parses a complete package", () => {
    const parsed = parseHandoffPackage(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(packageHoldReasons(parsed.package)).toEqual([]);
  });

  it("requires the core fields", () => {
    const parsed = parseHandoffPackage({ decisions: [] });
    expect(parsed).toEqual({ ok: false, issues: ["summary", "repo_path", "branch", "authorization_scope"] });
    expect(parseHandoffPackage("text")).toEqual({ ok: false, issues: ["package"] });
  });

  it("rejects malformed external operations", () => {
    const parsed = parseHandoffPackage({ ...valid, external_operations: [{ kind: "merge", correlation_id: "x", state: "maybe" }] });
    expect(parsed).toEqual({ ok: false, issues: ["external_operations"] });
  });

  it("holds the switch while a human wait or an uncertain operation remains", () => {
    const parsed = parseHandoffPackage({
      ...valid,
      human_waits: ["merge の承認"],
      external_operations: [{ kind: "merge", correlation_id: "pr-9", state: "uncertain" }],
    });
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(packageHoldReasons(parsed.package)).toEqual(["人間待ち: merge の承認", "結果不明の外部操作: merge(pr-9)"]);
  });

  it("renders a successor brief with the next instruction and correlation ids", () => {
    const parsed = parseHandoffPackage(valid);
    if (!parsed.ok) throw new Error("fixture must parse");
    const brief = renderHandoffBrief({ conversationId: "discord:-:1:2", handoffId: "hof_1", generation: 2, pkg: parsed.package, nextInstruction: "ログ画面の修正" });
    expect(brief).toContain("世代: 2");
    expect(brief).toContain("ログ画面の修正");
    expect(brief).toContain("migration 114 を追加 — 会話と交代の永続化");
    expect(brief).toContain("pr_submit: local-pr-1 (confirmed)");
    expect(brief).toContain("actio:2261f19a");
  });
});
