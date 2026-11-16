import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { awaitingResultReason, gatherClassifyInput, humanWaitReason, type ClassifyFactPorts } from "./classify-facts.js";
import { EMPTY_NUDGE_STATE } from "./patrol-nudge-policy.js";

const NOW = 1_000_000;

function session(patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s", provider: "claude-code", repo_path: "E:/s", repo_origin: "LUDIARS/Concordia", branch: "feat/s", host: "h",
    started_at: 1, ended_at: null, status: "active", last_seen_at: 1, current_task: null, transcript_path: null,
    metadata: "{}", ws_clients: 1, target_project: null, ...patch,
  } as SessionRow;
}

function ports(patch: Partial<ClassifyFactPorts> = {}): ClassifyFactPorts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    probes: {
      isAutoCheckDisabled: () => false,
      hasPendingQuestion: () => false,
      isHumanWaitActive: () => false,
      isWaitingForHumanResponse: () => false,
      isAwaitingAsk: async () => { calls.push("ask"); return false; },
    },
    listOpenLocalPrs: async () => [],
    runningDelegations: () => [],
    findLocalPrByBranch: async () => { calls.push("revisor"); return null; },
    findRun: () => null,
    parentReceivedRunTerminal: () => false,
    transcriptContains: async () => true,
    git: async () => { calls.push("git"); return { ok: true, stdout: "" }; },
    ...patch,
  };
}

const openPrs = (list: unknown[] | null) => async () => list as never;

describe("classify facts", () => {
  it("does not read the transcript, git or Revisor for recently active sessions", async () => {
    const p = ports();
    const input = await gatherClassifyInput({ ports: p, session: session(), lastActivitySec: NOW - 60, nudge: EMPTY_NUDGE_STATE, openPrs: openPrs([]), nowSec: NOW });
    expect(input).toMatchObject({ idleSec: 60, humanWait: null, uncommitted: null, workDone: null });
    expect(p.calls).toEqual([]);
  });

  it("reads uncommitted changes and merged work for idle sessions", async () => {
    const p = ports({
      git: async () => ({ ok: true, stdout: " M a.ts" }),
      findLocalPrByBranch: async () => ({ status: "merged", number: 9 }) as never,
    });
    const input = await gatherClassifyInput({ ports: p, session: session(), lastActivitySec: NOW - 3600, nudge: EMPTY_NUDGE_STATE, openPrs: openPrs([]), nowSec: NOW });
    expect(input).toMatchObject({ uncommitted: true, workDone: "担当 PR #9 マージ済み" });
  });

  it("treats a finished delegation child as done and leaves base branches alone", async () => {
    const child = session({ metadata: JSON.stringify({ delegation_run_id: "r1" }), branch: "main" });
    const p = ports({
      findRun: () => ({ child_session_id: "s", parent_session_id: "parent" }),
      parentReceivedRunTerminal: () => true,
    });
    const input = await gatherClassifyInput({ ports: p, session: child, lastActivitySec: NOW - 3600, nudge: EMPTY_NUDGE_STATE, openPrs: openPrs([]), nowSec: NOW });
    expect(input.workDone).toBe("依頼完了 (委託 run の終了を親が受信済み)");
    const base = await gatherClassifyInput({ ports: ports(), session: session({ branch: "main" }), lastActivitySec: NOW - 3600, nudge: EMPTY_NUDGE_STATE, openPrs: openPrs([]), nowSec: NOW });
    expect(base.workDone).toBeNull();
  });

  it("falls back to waiting when the wait state or the review list cannot be read", async () => {
    const broken = ports().probes;
    expect(await humanWaitReason(session(), { ...broken, hasPendingQuestion: () => { throw new Error("db"); } }, false)).toBe("待ちの状態を確認できない");
    expect(await humanWaitReason(session(), { ...broken, isAwaitingAsk: async () => null }, true)).toBe("待ちの状態を確認できない");
    expect(await humanWaitReason(session(), { ...broken, isAwaitingAsk: async () => true }, true)).toBe("ask で人間の入力待ち");
    expect(awaitingResultReason(session(), null, [])).toBe("審査状況を確認できない");
    expect(awaitingResultReason(session(), [], ["run-1", "run-2"])).toBe("委託 run run-1 ほか 1 件 の結果待ち");
  });

  it("flags a delivered nudge missing from the conversation after the grace", async () => {
    const p = ports({ transcriptContains: async () => false });
    const nudge = { count: 1, lastAt: NOW - 600, reportedAt: null };
    const input = await gatherClassifyInput({ ports: p, session: session(), lastActivitySec: NOW - 3600, nudge, openPrs: openPrs([]), nowSec: NOW });
    expect(input.injectUnreflected).toBe(true);
    const reflected = await gatherClassifyInput({ ports: ports(), session: session(), lastActivitySec: NOW - 3600, nudge, openPrs: openPrs([]), nowSec: NOW });
    expect(reflected.injectUnreflected).toBe(false);
  });
});
