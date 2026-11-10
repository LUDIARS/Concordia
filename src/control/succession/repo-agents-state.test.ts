import { describe, expect, it } from "vitest";
import {
  addRequestedRow,
  expiredRepoAgents,
  patchRepoAgent,
  readRepoAgentOf,
  readRepoAgents,
  repoAgentOfMetadata,
  transitionRepoAgent,
  type RepoAgentRow,
  type RepoAgentStatus,
} from "./repo-agents-state.js";

const CHECKOUT = "E:/Document/Ars/Concordia/.wt-x";

function requested(now = 100): RepoAgentRow[] {
  const result = addRequestedRow([], { checkout: CHECKOUT, project_code: "Cc", trigger: "gate", rule: "task-branch", now });
  if (!result.ok) throw new Error(result.reason);
  return result.rows;
}

function moveAll(rows: RepoAgentRow[], path: RepoAgentStatus[]): RepoAgentRow[] {
  let current = rows;
  for (const to of path) {
    const result = transitionRepoAgent(current, CHECKOUT, to, 200);
    if (!result.ok) throw new Error(result.reason);
    current = result.rows;
  }
  return current;
}

describe("repo-agents-state (§3.4)", () => {
  it("図の遷移 requested → spawning → active → ended を許す", () => {
    expect(moveAll(requested(), ["spawning", "active", "ended"])[0]?.status).toBe("ended");
    expect(moveAll(requested(), ["brief_missing"])[0]?.status).toBe("brief_missing");
    expect(moveAll(requested(), ["spawning", "spawn_failed"])[0]?.status).toBe("spawn_failed");
  });

  it.each([
    [[], "active"],
    [[], "ended"],
    [["spawning"], "brief_missing"],
    [["spawning"], "requested"],
    [["spawning", "active"], "spawn_failed"],
    [["spawning", "active", "ended"], "active"],
    [["brief_missing"], "spawning"],
  ] as Array<[RepoAgentStatus[], RepoAgentStatus]>)("図にない遷移は拒否する (%j → %s)", (path, to) => {
    const rows = moveAll(requested(), path);
    const result = transitionRepoAgent(rows, CHECKOUT, to, 300);
    expect(result.ok).toBe(false);
  });

  it("行の無い checkout の遷移は not_found", () => {
    expect(transitionRepoAgent([], CHECKOUT, "spawning", 1)).toEqual({ ok: false, reason: "not_found" });
  });

  it("同じ checkout に生きた行があれば重複行を作らない (大小・区切りの違いも同じ checkout)", () => {
    const rows = moveAll(requested(), ["spawning"]);
    expect(addRequestedRow(rows, { checkout: "e:\\document\\ars\\concordia\\.wt-x", project_code: null, trigger: "manual", rule: null, now: 5 }))
      .toEqual({ ok: false, reason: "already_assigned" });
  });

  it("終端の行は新しい依頼で置き換え、 行は 1 つのまま", () => {
    const rows = moveAll(requested(), ["spawning", "spawn_failed"]);
    const result = addRequestedRow(rows, { checkout: CHECKOUT, project_code: "Cc", trigger: "manual", rule: null, now: 500 });
    expect(result.ok && result.rows).toHaveLength(1);
    expect(result.ok && result.rows[0]?.status).toBe("requested");
  });

  it("遷移で欄を更新し、 状態を変えない patch もできる", () => {
    const spawning = transitionRepoAgent(requested(), CHECKOUT, "spawning", 150, { spawn_id: "s1" });
    expect(spawning.ok && spawning.row).toMatchObject({ status: "spawning", spawn_id: "s1", updated_at: 150 });
    const patched = patchRepoAgent(requested(), CHECKOUT, { pending_brief: "依頼" });
    expect(patched.ok && patched.row).toMatchObject({ status: "requested", pending_brief: "依頼" });
  });

  it("metadata から読み、 壊れた行は捨てる", () => {
    const rows = readRepoAgents({ repo_agents: [...requested(), { checkout: "x", status: "weird" }, "bad", null] });
    expect(rows).toHaveLength(1);
    expect(readRepoAgents({ repo_agents: "nope" })).toEqual([]);
  });

  it("子の repo_agent_of を書いて読み戻せる", () => {
    const value = repoAgentOfMetadata({ parentSessionId: "p1", checkout: CHECKOUT, projectCode: "Cc" });
    expect(readRepoAgentOf({ repo_agent_of: value })).toEqual({ parent_session_id: "p1", checkout: CHECKOUT, project_code: "Cc" });
    expect(readRepoAgentOf({ repo_agent_of: { checkout: CHECKOUT } })).toBeNull();
  });

  it("時間切れ: 依頼文の無い requested は brief_missing、 spawning は spawn_failed、 保留依頼文ありは待つ", () => {
    const base = requested(0);
    expect(expiredRepoAgents(base, 599, { briefTimeoutSec: 600, spawningTimeoutSec: 300 })).toEqual([]);
    expect(expiredRepoAgents(base, 600, { briefTimeoutSec: 600, spawningTimeoutSec: 300 }))
      .toEqual([{ checkout: CHECKOUT, to: "brief_missing" }]);
    const held = patchRepoAgent(base, CHECKOUT, { pending_brief: "依頼" });
    expect(held.ok && expiredRepoAgents(held.rows, 10_000, { briefTimeoutSec: 600, spawningTimeoutSec: 300 })).toEqual([]);
    const spawning = transitionRepoAgent(base, CHECKOUT, "spawning", 1000);
    expect(spawning.ok && expiredRepoAgents(spawning.rows, 1300, { briefTimeoutSec: 600, spawningTimeoutSec: 300 }))
      .toEqual([{ checkout: CHECKOUT, to: "spawn_failed" }]);
  });
});
