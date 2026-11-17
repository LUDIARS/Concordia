import { describe, expect, it } from "vitest";
import {
  classifyChild,
  decideReap,
  nextReapStep,
  parseReapState,
  REAP_DONE_IDLE_SEC,
  REAP_NOTICE_GRACE_SEC,
  REAP_NOTICE_RESPONSE_SEC,
  REAP_UNRESPONSIVE_IDLE_SEC,
  runParentSessionId,
  type ReapBlockers,
  type ReapInput,
} from "./reaper-policy.js";

const clear: ReapBlockers = {
  humanWait: false, pendingQuestion: false, waitingHumanResponse: false, askMarker: false,
  openReviewPr: false, testingClaim: false, unsavedWork: false,
};

function input(patch: Partial<ReapInput> = {}): ReapInput {
  return {
    kind: "delegation", idleSec: REAP_DONE_IDLE_SEC, unchangedCount: 0, delegationDone: true,
    repoAgentPrMerged: null, blockers: clear, ...patch,
  };
}

describe("classifyChild (CC-CTL-INV-08: 作業指示で起動した子だけ)", () => {
  const noRun = () => null;
  it("reads the repo-agent parent from repo_agent_of", () => {
    expect(classifyChild({ sessionId: "c", metadata: { repo_agent_of: { parent_session_id: "p" } }, findRun: noRun }))
      .toEqual({ kind: "repo-agent", parentSessionId: "p", runId: null });
  });

  it("treats a delegation child only when the run records this session as its child", () => {
    const findRun = (id: string) => (id === "r1" ? { child_session_id: "c", parent_session_id: "p" } : null);
    expect(classifyChild({ sessionId: "c", metadata: { delegation_run_id: "r1" }, findRun }))
      .toEqual({ kind: "delegation", parentSessionId: "p", runId: "r1" });
    expect(classifyChild({ sessionId: "other", metadata: { delegation_run_id: "r1" }, findRun })).toBeNull();
    expect(classifyChild({ sessionId: "c", metadata: { delegation_run_id: "missing" }, findRun })).toBeNull();
  });

  it("reads a spawn with a parent and ignores sessions without any parent record", () => {
    expect(classifyChild({ sessionId: "c", metadata: { delegation_parent_session_id: "p" }, findRun: noRun }))
      .toEqual({ kind: "spawn", parentSessionId: "p", runId: null });
    expect(classifyChild({ sessionId: "human", metadata: {}, findRun: noRun })).toBeNull();
    expect(classifyChild({ sessionId: "c", metadata: { repo_agent_of: { parent_session_id: " " } }, findRun: noRun })).toBeNull();
  });

  it("resolves a delegation parent from triggered_by only when it is a session id, and keeps parentless runs", () => {
    const sid = "lictor-24e68c85-b529-4592-8a5d-cf40fcbcee44";
    const run = (triggered_by: string | null) => () => ({ child_session_id: "c", parent_session_id: null, triggered_by });
    expect(classifyChild({ sessionId: "c", metadata: { delegation_run_id: "r" }, findRun: run(sid) }))
      .toEqual({ kind: "delegation", parentSessionId: sid, runId: "r" });
    expect(classifyChild({ sessionId: "c", metadata: { delegation_run_id: "r" }, findRun: run("cron:quaestor") }))
      .toEqual({ kind: "delegation", parentSessionId: null, runId: "r" });
    expect(runParentSessionId({ child_session_id: "c", parent_session_id: null, triggered_by: sid }, { delegation_parent_session_id: "m" }))
      .toBe("m");
  });
});

describe("decideReap: widened close conditions (2026-11-17)", () => {
  it("closes a delegation child whose run is terminal and PR is settled, even without the parent's receipt", () => {
    expect(decideReap(input({ delegationDone: false, runSettled: true }))).toEqual({ eligible: true, reason: "done_run_settled" });
    expect(decideReap(input({ delegationDone: false, runSettled: null })).eligible).toBe(false);
    expect(decideReap(input({ kind: "spawn", delegationDone: null, repoAgentPrMerged: true })))
      .toEqual({ eligible: true, reason: "done_merged" });
  });

  it("ignores a stale question card only for done reasons", () => {
    const blockers = { ...clear, pendingQuestion: true };
    expect(decideReap(input({ blockers, staleQuestionOnly: true })))
      .toEqual({ eligible: true, reason: "done_delegation", staleQuestion: true });
    expect(decideReap(input({ blockers, staleQuestionOnly: false }))).toEqual({ eligible: false, reason: "pendingQuestion" });
    expect(decideReap(input({
      kind: "spawn", delegationDone: null, idleSec: REAP_UNRESPONSIVE_IDLE_SEC, unchangedCount: 3, blockers, staleQuestionOnly: true,
    }))).toEqual({ eligible: false, reason: "pendingQuestion" });
    expect(decideReap(input({ blockers: { ...blockers, humanWait: true }, staleQuestionOnly: true })))
      .toEqual({ eligible: false, reason: "humanWait" });
  });

  it("starts over from the notice when the session answered after it", () => {
    const state = { noticed_at: 1000, reason: "done_delegation" as const, end_attempted_at: null };
    const ok = { eligible: true as const, reason: "done_delegation" as const };
    expect(nextReapStep(ok, state, 1000 + REAP_NOTICE_GRACE_SEC, 1000 + REAP_NOTICE_RESPONSE_SEC + 1)).toBe("notice");
    expect(nextReapStep(ok, state, 1000 + REAP_NOTICE_GRACE_SEC, 1000 + 10)).toBe("end");
    expect(parseReapState({ noticed_at: 1, reason: "done_run_settled" })?.reason).toBe("done_run_settled");
  });
});

describe("decideReap", () => {
  it("closes a delegation child after the parent received the terminal status and 30 minutes of silence", () => {
    expect(decideReap(input())).toEqual({ eligible: true, reason: "done_delegation" });
    expect(decideReap(input({ idleSec: REAP_DONE_IDLE_SEC - 1 }))).toEqual({ eligible: false, reason: "not_due" });
    expect(decideReap(input({ delegationDone: false }))).toEqual({ eligible: false, reason: "not_due" });
    expect(decideReap(input({ delegationDone: null }))).toEqual({ eligible: false, reason: "not_due" });
  });

  it("closes a repo-agent child whose PR is merged", () => {
    expect(decideReap(input({ kind: "repo-agent", delegationDone: null, repoAgentPrMerged: true })))
      .toEqual({ eligible: true, reason: "done_repo_agent" });
    expect(decideReap(input({ kind: "repo-agent", delegationDone: null, repoAgentPrMerged: false })).eligible).toBe(false);
  });

  it("treats 60 minutes of silence and 2 unchanged checks as unresponsive for any kind", () => {
    const base = { kind: "spawn" as const, delegationDone: null, idleSec: REAP_UNRESPONSIVE_IDLE_SEC };
    expect(decideReap(input({ ...base, unchangedCount: 2 }))).toEqual({ eligible: true, reason: "unresponsive" });
    expect(decideReap(input({ ...base, unchangedCount: 1 })).eligible).toBe(false);
    expect(decideReap(input({ ...base, idleSec: REAP_UNRESPONSIVE_IDLE_SEC - 1, unchangedCount: 5 })).eligible).toBe(false);
    expect(decideReap(input({ ...base, idleSec: null, unchangedCount: 5 }))).toEqual({ eligible: false, reason: "not_due" });
  });

  it("never closes while any wait, open review, testing claim or unsaved work is present, or cannot be read", () => {
    for (const key of Object.keys(clear) as Array<keyof ReapBlockers>) {
      expect(decideReap(input({ blockers: { ...clear, [key]: true } }))).toEqual({ eligible: false, reason: key });
      expect(decideReap(input({ blockers: { ...clear, [key]: null } }))).toEqual({ eligible: false, reason: `${key}_unknown` });
    }
  });
});

describe("nextReapStep (2 段)", () => {
  const ok = { eligible: true as const, reason: "unresponsive" as const };
  it("notices first, waits the grace, then ends, and never resends after an end attempt", () => {
    expect(nextReapStep(ok, null, 1000)).toBe("notice");
    const noticed = { noticed_at: 1000, reason: "unresponsive" as const, end_attempted_at: null };
    expect(nextReapStep(ok, noticed, 1000 + REAP_NOTICE_GRACE_SEC - 1)).toBe("wait_grace");
    expect(nextReapStep(ok, noticed, 1000 + REAP_NOTICE_GRACE_SEC)).toBe("end");
    expect(nextReapStep({ eligible: false, reason: "humanWait" }, noticed, 1000 + REAP_NOTICE_GRACE_SEC)).toBe("none");
    expect(nextReapStep(ok, { ...noticed, end_attempted_at: 2000 }, 9999)).toBe("end_attempted");
  });

  it("parses only well-formed state", () => {
    expect(parseReapState({ noticed_at: 1, reason: "done_delegation" })).toEqual({ noticed_at: 1, reason: "done_delegation", end_attempted_at: null });
    expect(parseReapState({ noticed_at: 1, reason: "other" })).toBeNull();
    expect(parseReapState(null)).toBeNull();
  });
});
