import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DailyGoalRepository } from "./repository.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() { const db = new Database(":memory:"); databases.push(db); return { db, repo: new DailyGoalRepository(db) }; }
const goal = {
  id: "g1", date: "2026-10-10", project: "Concordia", repoPath: "E:/repo", goalText: "出荷", acceptance: ["A"], actioTaskIds: ["t1"],
  permissions: { merge: false, test: true, service: false, deploy: false },
  confirmedBy: { platform: "discord" as const, userId: "u", guildId: "g", channelId: "c" }, confirmedAt: 1, createdAt: 1,
};

describe("DailyGoalRepository (CC-DG-INV-02 / CC-INV-03)", () => {
  it("returns the existing goal for a retried confirmation", () => {
    const { repo } = setup();
    expect(repo.create(goal).created).toBe(true);
    expect(repo.create({ ...goal, goalText: "別" })).toMatchObject({ created: false, goal: { goalText: "出荷", status: "confirmed", launchState: "none" } });
  });

  it("lets only one launch intent through, survives restart, and never releases a reconciled unknown", () => {
    const { repo, db } = setup();
    repo.create(goal);
    expect(repo.claimLaunch("g1", "run-1", 2)).toBe(true);
    expect(repo.claimLaunch("g1", "run-2", 3)).toBe(false);
    repo.markLaunchUnknown("g1", "timeout", 4);
    const recovered = new DailyGoalRepository(db);
    expect(recovered.byId("g1")).toMatchObject({ launchState: "unknown", runId: "run-1" });
    expect(recovered.claimLaunch("g1", "run-3", 5)).toBe(false);
    recovered.releaseLaunch("g1", "x", 99, 6);
    expect(recovered.byId("g1")?.launchState).toBe("unknown");
    expect(recovered.markLaunched("g1", "run-1", 7)).toBe(true);
    expect(recovered.byId("g1")).toMatchObject({ status: "running", launchState: "launched", launchedAt: 7 });
  });

  it("binds a session once and finishes only active goals", () => {
    const { repo } = setup();
    repo.create(goal); repo.claimLaunch("g1", "r", 1); repo.markLaunched("g1", "r", 2);
    expect(repo.bindSession("g1", "s1", 3)).toBe(true);
    expect(repo.bindSession("g1", "s2", 3)).toBe(false);
    expect(repo.bySession("s1").map((g) => g.id)).toEqual(["g1"]);
    expect(repo.finish("g1", { status: "exhausted", reason: "exhausted", remaining: [{ item: "A", class: "unachievable", reason: "r" }], now: 4 })).toBe(true);
    expect(repo.finish("g1", { status: "stopped", reason: "human_stop", now: 5 })).toBe(false);
    expect(repo.finishedOn("2026-10-10", "Concordia")[0]?.remaining).toHaveLength(1);
  });

  it("records checkpoint decisions once", () => {
    const { repo } = setup();
    repo.create(goal);
    repo.addCheckpoint({ id: "cp", goalId: "g1", at: 10, kind: "completion", evidence: { items: [], taskStatuses: {}, unavailable: [] }, progress: false, report: null, decision: "pending" });
    expect(repo.decideCheckpoint("cp", "go", "doable")).toBe(true);
    expect(repo.decideCheckpoint("cp", "exhausted", null)).toBe(false);
    expect(repo.lastCheckpoint("g1")).toMatchObject({ decision: "go", report: "doable" });
  });

  it("keeps a single card per goal: new posts need an intent, unknown results are not re-posted", () => {
    const { repo } = setup();
    repo.touchCard("goal-g1", "goal", "g1");
    expect(repo.pendingCards(0)).toHaveLength(1);
    expect(repo.claimCard("goal-g1", "ch")).toBe(true);
    expect(repo.claimCard("goal-g1", "ch")).toBe(false);
    repo.cardUnknown("goal-g1", "socket closed");
    expect(repo.pendingCards(0)).toHaveLength(0);
    expect(repo.unknownCards()).toHaveLength(1);
    repo.saveCard("goal-g1", 0, "ch", "m1");
    expect(repo.card("goal-g1")).toMatchObject({ messageId: "m1", deliveryStatus: "pending" });
    repo.saveCard("goal-g1", 1, "ch", "m1");
    repo.touchCard("goal-g1", "goal", "g1");
    expect(repo.pendingCards(0)[0]).toMatchObject({ revision: 2, messageId: "m1" });
    expect(repo.cardByMessage("m1")?.id).toBe("goal-g1");
  });

  it("stores candidates and reports only real changes", () => {
    const { repo } = setup();
    const candidate = { id: "c1", date: "2026-10-10", project: "p", repoPath: "r", suggestedGoal: "x", suggestedAcceptance: [], actioTaskIds: [], actioTasks: [], carryover: [], continuing: [], createdAt: 1 };
    expect(repo.upsertCandidate(candidate)).toBe(true);
    expect(repo.upsertCandidate({ ...candidate, createdAt: 2 })).toBe(false);
    expect(repo.upsertCandidate({ ...candidate, suggestedGoal: "y" })).toBe(true);
    expect(repo.candidate("c1")?.suggestedGoal).toBe("y");
  });
});
