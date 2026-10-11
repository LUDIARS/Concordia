/** @implements spec/feature/task-workflow-v3.md — Actio task sync: work key (CC-TF-SYNC-01) */

import { describe, expect, it } from "vitest";
import { mergeTaskflowReference, normalizeWorkTitle, resolveWorkUnit, specPathOf } from "./work-key.js";

const REPO = "E:\\Document\\Ars\\Concordia";

describe("resolveWorkUnit", () => {
  it("reuses an explicit taskflow_reference instead of creating a task", () => {
    expect(resolveWorkUnit({ args: { taskflow_reference: " actio:abc-1 " }, repoPath: REPO, branch: "feat/x", title: "t" }))
      .toEqual({ kind: "reference", reference: "actio:abc-1" });
  });

  it("keys a task spec file by repository and path, independent of the body and branch", () => {
    const a = resolveWorkUnit({ args: { task: "続きを実装する\n詳細は spec/tasks/2026-10-01-x.md" }, repoPath: REPO, branch: "feat/a", title: "A" });
    const b = resolveWorkUnit({ args: { task: "前任の続きを引き継ぐ。spec/tasks/2026-10-01-x.md" }, repoPath: REPO, branch: "feat/b", title: "B" });
    expect(a).toEqual({ kind: "key", sourceRef: "work:e:/document/ars/concordia:spec/tasks/2026-10-01-x.md" });
    expect(b).toEqual(a);
  });

  it("falls back to branch and normalized title so a rewritten handoff body keeps the same key", () => {
    const a = resolveWorkUnit({ args: { task: "本文 1" }, repoPath: REPO, branch: "feat/x", title: "MMO フィールド移動モック" });
    const b = resolveWorkUnit({ args: { task: "本文 2 (引き継ぎ)" }, repoPath: REPO, branch: "feat/x", title: "mmo  フィールド移動モック" });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ sourceRef: "work:e:/document/ars/concordia:feat/x:mmo-フィールド移動モック" });
  });
});

describe("specPathOf", () => {
  it("prefers a task spec anywhere in the arguments", () => {
    expect(specPathOf({ task: "設計の正本: spec/faq/a.md", context_extra: "spec/tasks/b.md" })).toBe("spec/tasks/b.md");
  });

  it("treats a design file as the work only when the first line of the request names it", () => {
    expect(specPathOf({ task: "Concordia で実装する。設計の正本: spec/faq/actio-cc-task-project-sync.md (§4)" }))
      .toBe("spec/faq/actio-cc-task-project-sync.md");
    expect(specPathOf({ task: "バグを直す\n参考: spec/feature/delegation.md" })).toBeNull();
  });
});

describe("normalizeWorkTitle", () => {
  it("folds case, width and punctuation", () => {
    expect(normalizeWorkTitle("Ｆｅａｔ: Work-Key 実装！")).toBe("feat-work-key-実装");
  });
});

describe("mergeTaskflowReference", () => {
  it("moves the explicit input into args and refuses a conflicting reference", () => {
    expect(mergeTaskflowReference({ task: "x" }, "actio:a")).toEqual({ ok: true, args: { task: "x", taskflow_reference: "actio:a" } });
    expect(mergeTaskflowReference({ taskflow_reference: "actio:a" }, "actio:a")).toMatchObject({ ok: true });
    expect(mergeTaskflowReference({ taskflow_reference: "actio:b" }, "actio:a")).toEqual({ ok: false, error: "taskflow_reference_conflict" });
    expect(mergeTaskflowReference({ task: "x" }, undefined)).toEqual({ ok: true, args: { task: "x" } });
  });
});
