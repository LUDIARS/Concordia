import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { CONTROL_REAPER_NOTICE, createChildReaper, type ChildReaperDeps } from "./reaper.js";
import { REAP_NOTICE_GRACE_SEC, REAP_STATE_METADATA_KEY } from "./reaper-policy.js";

function session(id: string, metadata: Record<string, unknown>): SessionRow {
  return {
    id, provider: "claude-code", repo_path: `E:/${id}`, repo_origin: "LUDIARS/Concordia", branch: `feat/${id}`, host: "h",
    started_at: 1, ended_at: null, status: "active", last_seen_at: 1, current_task: null, transcript_path: null,
    metadata: JSON.stringify(metadata), ws_clients: 1, target_project: null,
  } as SessionRow;
}

function harness(patch: Partial<ChildReaperDeps> = {}) {
  let nowMs = 10_000_000_000;
  const rows = new Map<string, SessionRow>();
  const injected: Array<{ to: string; text: string }> = [];
  const ended: string[] = [];
  const posts: string[] = [];
  let enabled = true;
  const deps: ChildReaperDeps = {
    isEnabled: () => enabled,
    findRun: (id) => (id === "r1" ? { child_session_id: "child", parent_session_id: "parent" } : null),
    isResidentChild: (id) => id === "resident",
    isControlSession: (s) => s.id === "ctl",
    parentReceivedRunTerminal: () => true,
    lastActivitySec: () => Math.floor(nowMs / 1000) - 2 * 60 * 60,
    unchangedCount: () => 0,
    hasPendingQuestion: () => false,
    isHumanWaitActive: () => false,
    isWaitingForHumanResponse: () => false,
    isAwaitingAsk: async () => false,
    hasTestingClaim: () => false,
    listOpenLocalPrs: async () => [],
    findLocalPrByBranch: async () => null,
    git: async (_cwd, args) => ({ ok: true, stdout: args[0] === "rev-list" ? "0" : "" }),
    updateMetadata: (id, update) => {
      const row = rows.get(id)!;
      rows.set(id, { ...row, metadata: JSON.stringify(update(JSON.parse(row.metadata ?? "{}"))) });
    },
    inject: (to, text) => { injected.push({ to, text }); return true; },
    endSession: async (id) => { ended.push(id); },
    postToChannel: async (text) => { posts.push(text); },
    now: () => nowMs,
    log: { info: () => {}, warn: () => {} },
    ...patch,
  };
  const reaper = createChildReaper(deps);
  return {
    reaper, rows, injected, ended, posts,
    put: (...list: SessionRow[]) => { for (const s of list) rows.set(s.id, s); },
    tick: () => reaper.runOnce([...rows.values()]),
    advanceSec: (sec: number) => { nowMs += sec * 1000; },
    disable: () => { enabled = false; },
  };
}

const child = () => session("child", { delegation_run_id: "r1" });

describe("child reaper (CC-CTL-INV-08)", () => {
  it("notices once, waits the grace, then ends through the session end path and tells the parent and the channel", async () => {
    const h = harness();
    h.put(child());
    expect((await h.tick()).noticed).toEqual(["child"]);
    expect(h.injected[0]).toEqual({ to: "child", text: CONTROL_REAPER_NOTICE });
    expect(h.injected[1].to).toBe("parent");
    expect(JSON.parse(h.rows.get("child")!.metadata!)[REAP_STATE_METADATA_KEY].reason).toBe("done_delegation");
    expect(h.posts[0]).toContain("終了を案内: 1 件 (child)");

    h.advanceSec(60);
    expect(await h.tick()).toEqual({ noticed: [], ended: [], failed: [], endedDetail: [] });
    expect(h.injected.filter((i) => i.to === "child")).toHaveLength(1);

    h.advanceSec(REAP_NOTICE_GRACE_SEC);
    expect((await h.tick()).ended).toEqual(["child"]);
    expect(h.ended).toEqual(["child"]);
    expect(h.injected.filter((i) => i.to === "parent").map((i) => i.text).at(-1)).toContain("を閉じました");
    expect(h.posts.at(-1)).toContain("閉じた: 1 件 (child)");
  });

  it("does not end when a blocker appears during the grace", async () => {
    let humanWait = false;
    const h = harness({ isHumanWaitActive: () => humanWait });
    h.put(child());
    await h.tick();
    humanWait = true;
    h.advanceSec(REAP_NOTICE_GRACE_SEC);
    await h.tick();
    expect(h.ended).toEqual([]);
  });

  it("does not resend when the end result is unknown", async () => {
    const h = harness({ endSession: async () => { throw new Error("timeout"); } });
    h.put(child());
    await h.tick();
    h.advanceSec(REAP_NOTICE_GRACE_SEC);
    expect((await h.tick()).failed).toEqual(["child"]);
    h.advanceSec(REAP_NOTICE_GRACE_SEC);
    expect(await h.tick()).toEqual({ noticed: [], ended: [], failed: [], endedDetail: [] });
    expect(h.injected.filter((i) => i.to === "parent").at(-1)!.text).toContain("終了結果が分かりません");
  });

  it("ignores human-started, control, resident and recently active sessions", async () => {
    const h = harness({
      lastActivitySec: (id) => (id === "fresh" ? Math.floor(10_000_000_000 / 1000) : Math.floor(10_000_000_000 / 1000) - 7200),
    });
    h.put(
      session("human", {}),
      session("ctl", { delegation_parent_session_id: "p" }),
      session("resident", { delegation_parent_session_id: "p" }),
      session("fresh", { delegation_parent_session_id: "p" }),
    );
    expect(await h.tick()).toEqual({ noticed: [], ended: [], failed: [], endedDetail: [] });
    expect(h.injected).toEqual([]);
  });

  it("closes an unresponsive spawn child but not one that keeps changing", async () => {
    let unchanged = 2;
    const h = harness({ unchangedCount: () => unchanged });
    h.put(session("spawned", { delegation_parent_session_id: "parent" }));
    expect((await h.tick()).noticed).toEqual(["spawned"]);
    unchanged = 0;
    const h2 = harness({ unchangedCount: () => 1 });
    h2.put(session("spawned", { delegation_parent_session_id: "parent" }));
    expect((await h2.tick()).noticed).toEqual([]);
  });

  it("ends a standalone session whose branch PR is merged after one notice and the grace, without a parent", async () => {
    const merged = { status: "merged", number: 7, headSha: "h" } as never;
    const h = harness({ findLocalPrByBranch: async () => merged });
    h.put(session("solo", {}));
    expect((await h.tick()).noticed).toEqual(["solo"]);
    expect(h.injected).toEqual([{ to: "solo", text: CONTROL_REAPER_NOTICE }]);
    h.advanceSec(REAP_NOTICE_GRACE_SEC);
    const report = await h.tick();
    expect(report.ended).toEqual(["solo"]);
    expect(report.endedDetail).toEqual([{ session_id: "solo", reason: "担当 PR がマージ済み" }]);
    expect(h.ended).toEqual(["solo"]);
    expect(h.injected.map((i) => i.to)).toEqual(["solo"]);
  });

  it("does not end a merged standalone session that waits for a human or has uncommitted changes", async () => {
    const merged = { status: "merged", number: 7, headSha: "h" } as never;
    const waiting = harness({ findLocalPrByBranch: async () => merged, isHumanWaitActive: () => true });
    waiting.put(session("solo", {}));
    expect((await waiting.tick()).noticed).toEqual([]);
    const dirty = harness({ findLocalPrByBranch: async () => merged, git: async () => ({ ok: true, stdout: " M src/a.ts" }) });
    dirty.put(session("solo", {}));
    expect((await dirty.tick()).noticed).toEqual([]);
    const onMain = harness({ findLocalPrByBranch: async () => merged });
    onMain.put({ ...session("solo", {}), branch: "main" });
    expect((await onMain.tick()).noticed).toEqual([]);
    const unresponsiveOnly = harness({ unchangedCount: () => 5 });
    unresponsiveOnly.put(session("solo", {}));
    expect((await unresponsiveOnly.tick()).noticed).toEqual([]);
    expect(dirty.ended).toEqual([]);
  });

  it("does nothing while the setting is OFF and does not record a notice that was not delivered", async () => {
    const h = harness();
    h.put(child());
    h.disable();
    expect(await h.tick()).toEqual({ noticed: [], ended: [], failed: [], endedDetail: [] });
    const h2 = harness({ inject: () => false });
    h2.put(child());
    expect((await h2.tick()).noticed).toEqual([]);
    expect(JSON.parse(h2.rows.get("child")!.metadata!)[REAP_STATE_METADATA_KEY]).toBeUndefined();
  });
});
