import { describe, expect, it } from "vitest";
import { createEvidenceAdapter, parseCommitLog, prEvidence } from "./evidence.js";
import type { DailyGoal } from "./domain.js";

const goal = { id: "g", sessionId: "s1", repoPath: "E:/repo", actioTaskIds: ["t1", "t2"] } as DailyGoal;

describe("evidence collection (CC-DG-INV-03 / CC-DG-INV-08)", () => {
  it("parses commit logs and PR state changes into stable evidence keys", () => {
    expect(parseCommitLog("abc1234\t1700000000\tfeat: x\nnot-a-sha\t1\ty\n")).toEqual([
      { key: "commit:abc1234", kind: "commit", summary: "feat: x", at: 1_700_000_000_000 },
    ]);
    expect(prEvidence([{ repo_origin: "o", number: 3, state: "merged", review_state: "approved", updated_at: 2_000, title: "t" }], 1_000_000).map((i) => i.key))
      .toEqual(["pr:o#3:merged", "pr:o#3:review:approved"]);
    expect(prEvidence([{ repo_origin: "o", number: 3, state: "open", review_state: "none", updated_at: 1, title: "t" }], 5_000)).toEqual([]);
  });

  it("collects commits on the session branch, PRs, Revisor state and Actio statuses read-only", async () => {
    const calls: string[][] = [];
    const port = createEvidenceAdapter({
      session: () => ({ repo_path: "E:/wt", repo_origin: "https://x/o.git", branch: "feat/x" }),
      prsBySession: () => [{ repo_origin: "o", number: 1, state: "open", review_state: "none", updated_at: 9_999_999_999, title: "t" }],
      revisorByBranch: async () => ({ id: "r1", number: 5, status: "open", checkStatus: "test_ok", title: "t", updatedAt: "2026-10-10T00:00:00Z" }),
      taskStatus: async (_repo, ref) => (ref === "actio:t1" ? { status: "done" } : { status: "pending" }),
      git: async (cwd, args) => { calls.push([cwd, ...args]); return "deadbee\t1700000000\tfix\n"; },
    });
    const snap = await port.collect(goal, 1_000);
    expect(calls[0]?.slice(0, 3)).toEqual(["E:/wt", "log", "--since=@1"]);
    expect(snap.items.map((i) => i.key)).toEqual(["commit:deadbee", "pr:o#1:open", "revisor:r1:open:test_ok", "actio:t1:done"]);
    expect(snap.taskStatuses).toEqual({ t1: "done", t2: "pending" });
    expect(snap.unavailable).toEqual([]);
  });

  it("reports unreadable sources instead of an empty success", async () => {
    const port = createEvidenceAdapter({
      session: () => ({ repo_path: "E:/wt", repo_origin: null, branch: "feat/x" }),
      prsBySession: () => { throw new Error("db"); },
      taskStatus: async () => { throw new Error("actio down"); },
      git: async () => { throw new Error("git"); },
    });
    const snap = await port.collect(goal, 0);
    expect(snap.unavailable).toEqual(["git", "pr_records", "actio"]);
    expect(snap.taskStatuses).toEqual({ t1: "unknown", t2: "unknown" });
  });
});
