import { describe, expect, it } from "vitest";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import type { SessionRow } from "../shared/types.js";
import { gatherReapInput, linkedTasksAllDone, type ReaperFactPorts, type ReaperGitRunner } from "./reaper-facts.js";

const NOW = 100_000;

function session(patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "c", provider: "claude-code", repo_path: "E:/w", repo_origin: "LUDIARS/Concordia", branch: "feat/x", host: "h",
    started_at: 1, ended_at: null, status: "active", last_seen_at: 1, current_task: null, transcript_path: null,
    metadata: "{}", ws_clients: 1, target_project: null, ...patch,
  } as SessionRow;
}

function pr(patch: Partial<RevisorLocalPr> = {}): RevisorLocalPr {
  return {
    id: "pr1", number: 1, repository: "LUDIARS/Concordia", title: "t", author: "a", status: "open", checkStatus: "running",
    headRef: "feat/x", baseRef: "main", headSha: "abc", createdAt: "", updatedAt: "", sessionId: null, ...patch,
  };
}

function git(outputs: Record<string, { ok: boolean; stdout: string }>): ReaperGitRunner {
  return async (_cwd, args) => outputs[args.join(" ")] ?? { ok: false, stdout: "" };
}

const cleanGit = git({
  "status --porcelain": { ok: true, stdout: "" },
  "rev-list --count main..HEAD": { ok: true, stdout: "0\n" },
});

function ports(patch: Partial<ReaperFactPorts> = {}): ReaperFactPorts {
  return {
    parentReceivedRunTerminal: () => true,
    lastActivitySec: () => NOW - 4000,
    unchangedCount: () => 3,
    hasPendingQuestion: () => false,
    isHumanWaitActive: () => false,
    isWaitingForHumanResponse: () => false,
    isAwaitingAsk: async () => false,
    hasTestingClaim: () => false,
    listOpenLocalPrs: async () => [],
    findLocalPrByBranch: async () => null,
    git: cleanGit,
    ...patch,
  };
}

const delegation = { kind: "delegation" as const, parentSessionId: "p", runId: "r1" };

describe("gatherReapInput", () => {
  it("reads idle time, unchanged count and the parent's terminal receipt with no blockers on a clean worktree", async () => {
    const result = await gatherReapInput(ports(), session(), delegation, NOW);
    expect(result).toMatchObject({ kind: "delegation", idleSec: 4000, unchangedCount: 3, delegationDone: true, repoAgentPrMerged: null });
    expect(Object.values(result.blockers).every((v) => v === false)).toBe(true);
  });

  it("marks an open review PR by session or by branch", async () => {
    expect((await gatherReapInput(ports({ listOpenLocalPrs: async () => [pr({ sessionId: "c", headRef: "other" })] }), session(), delegation, NOW))
      .blockers.openReviewPr).toBe(true);
    expect((await gatherReapInput(ports({ listOpenLocalPrs: async () => [pr()] }), session(), delegation, NOW))
      .blockers.openReviewPr).toBe(true);
    expect((await gatherReapInput(ports({ listOpenLocalPrs: async () => { throw new Error("down"); } }), session(), delegation, NOW))
      .blockers.openReviewPr).toBeNull();
  });

  it("treats uncommitted changes and commits ahead of main without a submitted PR at HEAD as unsaved", async () => {
    const dirty = git({ "status --porcelain": { ok: true, stdout: " M a.ts\n" } });
    expect((await gatherReapInput(ports({ git: dirty }), session(), delegation, NOW)).blockers.unsavedWork).toBe(true);
    const ahead = git({
      "status --porcelain": { ok: true, stdout: "" },
      "rev-list --count main..HEAD": { ok: true, stdout: "2" },
      "rev-parse HEAD": { ok: true, stdout: "abc\n" },
    });
    expect((await gatherReapInput(ports({ git: ahead }), session(), delegation, NOW)).blockers.unsavedWork).toBe(true);
    expect((await gatherReapInput(ports({ git: ahead, findLocalPrByBranch: async () => pr({ status: "merged", headSha: "abc" }) }), session(), delegation, NOW))
      .blockers.unsavedWork).toBe(false);
    expect((await gatherReapInput(ports({ git: ahead, findLocalPrByBranch: async () => pr({ status: "merged", headSha: "old" }) }), session(), delegation, NOW))
      .blockers.unsavedWork).toBe(true);
  });

  it("returns null (= do not close) when git or the PR lookup cannot be read", async () => {
    expect((await gatherReapInput(ports({ git: git({}) }), session(), delegation, NOW)).blockers.unsavedWork).toBeNull();
    const ahead = git({
      "status --porcelain": { ok: true, stdout: "" },
      "rev-list --count main..HEAD": { ok: true, stdout: "1" },
      "rev-parse HEAD": { ok: true, stdout: "abc" },
    });
    expect((await gatherReapInput(ports({ git: ahead, findLocalPrByBranch: async () => { throw new Error("x"); } }), session(), delegation, NOW))
      .blockers.unsavedWork).toBeNull();
    expect((await gatherReapInput(ports({ isHumanWaitActive: () => { throw new Error("db"); } }), session(), delegation, NOW))
      .blockers.humanWait).toBeNull();
    expect((await gatherReapInput(ports({ isAwaitingAsk: async () => { throw new Error("io"); } }), session(), delegation, NOW))
      .blockers.askMarker).toBeNull();
  });

  it("reads repo-agent PR merge state by branch", async () => {
    const repoAgent = { kind: "repo-agent" as const, parentSessionId: "p", runId: null };
    expect((await gatherReapInput(ports({ findLocalPrByBranch: async () => pr({ status: "merged" }) }), session(), repoAgent, NOW)).repoAgentPrMerged).toBe(true);
    expect((await gatherReapInput(ports(), session({ branch: null }), repoAgent, NOW)).repoAgentPrMerged).toBeNull();
  });

  it("reads a shared-checkout session's PR by session, its run terminal state and tracked-only changes", async () => {
    const shared = git({
      "status --porcelain --untracked-files=no --ignore-submodules=all": { ok: true, stdout: "" },
      "rev-list --count main..HEAD": { ok: true, stdout: "0" },
    });
    const base = ports({
      git: shared,
      parentReceivedRunTerminal: () => false,
      findRun: () => ({ child_session_id: "c", parent_session_id: null, status: "partial" }),
      findLocalPrBySession: async (_repo, sid) => (sid === "c" ? pr({ status: "merged", headRef: "feat/other" }) : null),
    });
    const result = await gatherReapInput(base, session({ branch: "main" }), delegation, NOW);
    expect(result).toMatchObject({ runSettled: true, delegationDone: false });
    expect(result.blockers.unsavedWork).toBe(false);
    const running = ports({ ...base, findRun: () => ({ child_session_id: "c", parent_session_id: null, status: "running" }) });
    expect((await gatherReapInput(running, session({ branch: "main" }), delegation, NOW)).runSettled).toBe(false);
    const unknown = ports({ ...base, findLocalPrBySession: async () => { throw new Error("x"); } });
    expect((await gatherReapInput(unknown, session({ branch: "main" }), delegation, NOW)).runSettled).toBeNull();
  });

  it("marks a question card as stale only when the session kept working after it", async () => {
    const asked = NOW - 4000 - 11 * 60;
    expect((await gatherReapInput(ports({ hasPendingQuestion: () => true, latestUnansweredQuestionTs: () => asked }), session(), delegation, NOW))
      .staleQuestionOnly).toBe(true);
    expect((await gatherReapInput(ports({ hasPendingQuestion: () => true, latestUnansweredQuestionTs: () => NOW - 4000 }), session(), delegation, NOW))
      .staleQuestionOnly).toBe(false);
    expect((await gatherReapInput(ports({ latestUnansweredQuestionTs: () => asked }), session(), delegation, NOW)).staleQuestionOnly).toBe(false);
  });
});

describe("linked Actio tasks (2026-11-21)", () => {
  const view = (status: string, state: "current" | "unknown" = "current") => ({ status, state });

  it("is done only when every linked task is done or cancelled and all were read", () => {
    expect(linkedTasksAllDone({ kind: "current", links: [view("done"), view("cancelled")] })).toBe(true);
    expect(linkedTasksAllDone({ kind: "current", links: [view("done"), view("in_progress")] })).toBe(false);
    expect(linkedTasksAllDone({ kind: "current", links: [view("done"), view("unknown", "unknown")] })).toBeNull();
    expect(linkedTasksAllDone({ kind: "current", links: [] })).toBeNull();
    expect(linkedTasksAllDone({ kind: "stale_binding", links: [] })).toBeNull();
    expect(linkedTasksAllDone({ kind: "not_found", links: [] })).toBeNull();
  });

  it("passes the linked task state into the reap input and treats a failed read as unknown", async () => {
    const standalone = { kind: "standalone" as const, parentSessionId: null, runId: null };
    expect((await gatherReapInput(ports({ linkedTasksDone: async () => true }), session(), standalone, NOW)).linkedTasksDone).toBe(true);
    expect((await gatherReapInput(ports({ linkedTasksDone: async () => { throw new Error("actio down"); } }), session(), standalone, NOW)).linkedTasksDone).toBeNull();
    expect((await gatherReapInput(ports(), session(), standalone, NOW)).linkedTasksDone).toBeNull();
  });
});
