import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { SessionRow } from "../shared/types.js";
import { ControlBoardRepo, type ControlBoardEntry } from "./board-repo.js";
import type { ClassifyFactPorts } from "./classify-facts.js";
import type { ControlInjectEvent } from "./instruction-dispatch.js";
import type { EligibilityProbes } from "./instruction-eligibility.js";
import { createControlPatrol } from "./patrol.js";
import { patrolNudgeToken } from "./patrol-nudge-policy.js";

const MIN = 60;

function session(id: string, patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id, provider: "claude-code", repo_path: `E:/${id}`, repo_origin: "LUDIARS/Concordia", branch: `feat/${id}`, host: "h",
    started_at: 1, ended_at: null, status: "active", last_seen_at: 1, current_task: null, transcript_path: null,
    metadata: "{}", ws_clients: 1, target_project: null, ...patch,
  } as SessionRow;
}

function entry(sessionId: string, lastActivitySec: number): ControlBoardEntry {
  // 指紋なし (自動確認の記録が無い) 行。旧基準では停止 0 件になっていたデータ。
  return {
    session_id: sessionId, project: "Cc", branch: `feat/${sessionId}`, followup_state: null, fingerprint: null,
    unchanged_count: 0, current_task: null, side_summary: null, side_reported_at: null,
    last_activity_at: lastActivitySec, last_skip_reason: null, updated_at: lastActivitySec,
  };
}

function harness(opts: { probes?: Partial<EligibilityProbes>; facts?: Partial<ClassifyFactPorts> } = {}) {
  let nowMs = 2_000_000_000_000;
  const db = makeTestDb();
  const board = new ControlBoardRepo(db);
  const sessions = new Map<string, SessionRow>();
  const injected: ControlInjectEvent[] = [];
  const posts: string[] = [];
  const probes: EligibilityProbes = {
    isControlSession: () => false,
    isAutoCheckDisabled: () => false,
    hasPendingQuestion: () => false,
    isHumanWaitActive: () => false,
    isWaitingForHumanResponse: () => false,
    isAwaitingAsk: async () => false,
    ...opts.probes,
  };
  const facts: ClassifyFactPorts = {
    probes,
    listOpenLocalPrs: async () => [],
    runningDelegations: () => [],
    findLocalPrByBranch: async () => null,
    findRun: () => null,
    parentReceivedRunTerminal: () => false,
    // 届けた本文は会話に入っている (inject が会話に届く正常系)。
    transcriptContains: async (s, token) => injected.some((e) => e.target_session_id === s.id && e.text.includes(token)),
    git: async () => ({ ok: true, stdout: "" }),
    ...opts.facts,
  };
  const patrol = createControlPatrol({
    board, facts, probes,
    findSession: (id) => sessions.get(id) ?? null,
    inject: { canDeliver: () => true, emit: (event) => { injected.push(event); } },
    postToChannel: async (text) => { posts.push(text); return true; },
    now: () => nowMs,
    log: { info: () => {}, warn: () => {} },
  });
  const nowSec = () => Math.floor(nowMs / 1000);
  return {
    board, injected, posts,
    put(id: string, idleSec: number, patch: Partial<SessionRow> = {}) {
      sessions.set(id, session(id, patch));
      board.upsert(entry(id, nowSec() - idleSec));
    },
    tick: () => patrol.runOnce([...sessions.values()]),
    advanceSec: (sec: number) => { nowMs += sec * 1000; },
    nowSec,
  };
}

describe("control patrol (CC-CTL-INV-09)", () => {
  it("classifies every idle session without fingerprints and with no reason to wait as stalled and nudges it", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) h.put(id, 100 * MIN + 7 * MIN);
    const report = await h.tick();
    expect(report.classified.map((c) => c.status)).toEqual(["stalled", "stalled", "stalled"]);
    expect(report.nudged).toEqual(["a", "b", "c"]);
    expect(h.injected.map((e) => e.target_session_id)).toEqual(["a", "b", "c"]);
    expect(h.injected[0].text).toContain(patrolNudgeToken(1));
    expect(h.injected[0].text).toContain("管制の巡回からの追加指示");
    expect(h.board.list().map((r) => [r.status, r.status_reason, r.nudge_count])).toEqual([
      ["stalled", "待つ理由なし / 無活動 107 分", 1],
      ["stalled", "待つ理由なし / 無活動 107 分", 1],
      ["stalled", "待つ理由なし / 無活動 107 分", 1],
    ]);
  });

  it("does not nudge human waits or sessions awaiting review, but records the reason", async () => {
    const h = harness({
      probes: { hasPendingQuestion: (id) => id === "q" },
      facts: {
        listOpenLocalPrs: async () => [{ id: "p", number: 42, repository: "LUDIARS/Concordia", headRef: "feat/r", status: "open", checkStatus: "running", sessionId: "r" } as never],
      },
    });
    h.put("q", 120 * MIN);
    h.put("r", 120 * MIN);
    await h.tick();
    expect(h.injected).toEqual([]);
    expect(h.board.find("q")).toMatchObject({ status: "human_wait", status_reason: "質問カードの回答待ち" });
    expect(h.board.find("r")).toMatchObject({ status: "awaiting_result", status_reason: "審査中 PR #42 (running)" });
  });

  it("resends unanswered nudges at 20, 40 minutes, and after three deliveries reports the session as unresponsive by name", async () => {
    const h = harness();
    h.put("s", 30 * MIN);
    await h.tick();
    expect(h.injected).toHaveLength(1);

    h.advanceSec(20 * MIN - 60);
    await h.tick();
    expect(h.injected).toHaveLength(1);
    h.advanceSec(60);
    await h.tick();
    expect(h.injected).toHaveLength(2);
    expect(h.injected[1].text).toContain(patrolNudgeToken(2));

    h.advanceSec(40 * MIN - 60);
    await h.tick();
    expect(h.injected).toHaveLength(2);
    h.advanceSec(60);
    await h.tick();
    expect(h.injected).toHaveLength(3);
    expect(h.posts).toEqual([]);

    h.advanceSec(MIN);
    const report = await h.tick();
    expect(report.classified[0].status).toBe("unresponsive");
    expect(report.unresponsiveReported).toEqual(["s"]);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("- Cc s / 追加指示 3 回に反応なし");
    expect(h.posts[0]).toContain("直近の追加指示");

    // 報告は 1 回だけ。再送は 80 分後まで黙らずに続く。
    h.advanceSec(80 * MIN);
    await h.tick();
    expect(h.posts).toHaveLength(1);
    expect(h.injected).toHaveLength(4);
  });

  it("starts counting again when the conversation moves after a nudge", async () => {
    const h = harness();
    h.put("s", 30 * MIN);
    await h.tick();
    h.advanceSec(10 * MIN);
    h.board.upsert(entry("s", h.nowSec() - 30));
    await h.tick();
    expect(h.board.find("s")).toMatchObject({ status: "working", nudge_count: 0, nudge_last_at: null });
  });

  it("treats a delivered nudge that never reached the conversation as unresponsive", async () => {
    const h = harness({ facts: { transcriptContains: async () => false } });
    h.put("s", 30 * MIN);
    await h.tick();
    h.advanceSec(5 * MIN);
    const report = await h.tick();
    expect(report.classified[0]).toEqual({ session_id: "s", status: "unresponsive", reason: "追加指示が会話に入っていない疑い / 無活動 35 分" });
    expect(h.posts[0]).toContain("追加指示が会話に入っていない疑い");
  });
});
