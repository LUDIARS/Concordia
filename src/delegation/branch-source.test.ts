import { describe, expect, it } from "vitest";
import { findBranchMentions, resolveDelegationBranch } from "./branch-source.js";

describe("findBranchMentions", () => {
  it("picks up a branch named after the word branch", () => {
    // 2026-09-05 の実際の指示書の一節。
    const text = "作業場所: E:/Document/Ars/.wt-Quaestor-mail-realtime (worktree 作成済み、branch feat/mail-realtime-pubsub、起点 90b156a)。";
    expect(findBranchMentions(text)).toEqual(["feat/mail-realtime-pubsub"]);
  });

  it("understands the Japanese word and a colon form", () => {
    expect(findBranchMentions("Cc 登録 branch: feat/mail-realtime-pubsub")).toEqual(["feat/mail-realtime-pubsub"]);
    expect(findBranchMentions("ブランチ feat/x を使う")).toEqual(["feat/x"]);
    expect(findBranchMentions("worktree 作成済み、branch feat/z、起点 abc1234")).toEqual(["feat/z"]);
  });

  it("ignores prose that mentions branches without naming one", () => {
    expect(findBranchMentions("Create a feature branch off origin/main.")).toEqual([]);
    expect(findBranchMentions("branch を切ってから実装する")).toEqual([]);
  });

  it("ignores a branch the delegate is told to create itself", () => {
    // seed テンプレ daily-review-autofix の実文。 構造化 branch を渡さないのが正しい形。
    expect(findBranchMentions("- Create branch chore/review-fix-2026-07-04 off origin/main.")).toEqual([]);
    expect(findBranchMentions("ブランチ feat/x を作成する")).toEqual([]);
    expect(findBranchMentions("git checkout -b branch feat/y")).toEqual([]);
  });

  it("ignores file paths that merely look branch-shaped", () => {
    // spec/feature/... は指示書に頻出する。 誤検知で spawn を止めない。
    expect(findBranchMentions("spec/feature/mail-realtime.md を更新する")).toEqual([]);
    expect(findBranchMentions("docs/plan/2026-09-04.md")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(findBranchMentions(null)).toEqual([]);
    expect(findBranchMentions("")).toEqual([]);
  });
});

describe("resolveDelegationBranch", () => {
  it("prefers the contract branch over the argument", () => {
    expect(resolveDelegationBranch({ contractBranch: "feat/a", argumentBranch: "feat/b" })).toEqual({
      ok: true,
      branch: "feat/a",
      source: "contract",
    });
  });

  it("falls back to the argument branch", () => {
    expect(resolveDelegationBranch({ contractBranch: null, argumentBranch: " feat/b " })).toEqual({
      ok: true,
      branch: "feat/b",
      source: "argument",
    });
  });

  it("allows a spawn with no branch anywhere", () => {
    expect(resolveDelegationBranch({ promptText: "調査して報告する" })).toEqual({
      ok: true,
      branch: null,
      source: "none",
    });
  });

  it("blocks the 2026-09-05 case: task text names a branch but none was passed", () => {
    const result = resolveDelegationBranch({
      contractBranch: null,
      argumentBranch: null,
      promptText: "作業場所は worktree (branch feat/mail-realtime-pubsub、起点 90b156a)。",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("feat/mail-realtime-pubsub");
  });

  it("blocks a mismatch between the task text and the structured branch", () => {
    const result = resolveDelegationBranch({
      argumentBranch: "feat/other",
      promptText: "branch feat/mail-realtime-pubsub で作業する",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("mismatch");
  });

  it("accepts a task text that agrees with the structured branch", () => {
    expect(
      resolveDelegationBranch({
        argumentBranch: "feat/mail-realtime-pubsub",
        promptText: "branch feat/mail-realtime-pubsub で作業する",
      }),
    ).toEqual({ ok: true, branch: "feat/mail-realtime-pubsub", source: "argument" });
  });
});
