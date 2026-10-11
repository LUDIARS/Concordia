/** @implements spec/feature/task-workflow-v3.md — Actio task sync: handoff reuse (CC-TF-SYNC-02) */

import { describe, expect, it } from "vitest";
import { isRunOver, selectHandoffReference, type HandoffCandidate } from "./handoff-task.js";

const REPO = "E:/Document/Ars/Ludellus-Server";

function run(overrides: Partial<HandoffCandidate>): HandoffCandidate {
  return { runId: "r1", reference: "actio:t1", targetRepo: REPO, branch: "feat/mmo", runStatus: "running",
    sessionStatus: "active", createdAt: 1, ...overrides };
}

describe("selectHandoffReference", () => {
  it("continues the task of a predecessor whose session was lost", () => {
    expect(selectHandoffReference([run({ sessionStatus: "lost" })], { repoPath: "e:\\document\\ars\\ludellus-server", branch: "feat/mmo" }))
      .toBe("actio:t1");
  });

  it("does not take over a task while another run is still working on it", () => {
    expect(selectHandoffReference([
      run({ runId: "r1", sessionStatus: "ended", createdAt: 1 }),
      run({ runId: "r2", sessionStatus: "active", createdAt: 2 }),
    ], { repoPath: REPO, branch: "feat/mmo" })).toBeNull();
  });

  it("chooses the newest ended task on the same repository and branch only", () => {
    expect(selectHandoffReference([
      run({ reference: "actio:old", runStatus: "completed", createdAt: 1 }),
      run({ reference: "actio:new", runStatus: "failed", createdAt: 5 }),
      run({ reference: "actio:other-branch", branch: "feat/other", runStatus: "failed", createdAt: 9 }),
      run({ reference: "actio:other-repo", targetRepo: "E:/Document/Ars/Actio", runStatus: "failed", createdAt: 9 }),
      run({ reference: "legacy.md", runStatus: "failed", createdAt: 9 }),
    ], { repoPath: REPO, branch: "feat/mmo" })).toBe("actio:new");
  });

  it("never guesses without a branch", () => {
    expect(selectHandoffReference([run({ sessionStatus: "lost" })], { repoPath: REPO, branch: null })).toBeNull();
  });
});

describe("isRunOver", () => {
  it("treats terminal runs and ended sessions as over", () => {
    expect(isRunOver({ runStatus: "spawn_failed", sessionStatus: null })).toBe(true);
    expect(isRunOver({ runStatus: "running", sessionStatus: "ended" })).toBe(true);
    expect(isRunOver({ runStatus: "running", sessionStatus: "active" })).toBe(false);
    expect(isRunOver({ runStatus: "queued", sessionStatus: null })).toBe(false);
  });
});
