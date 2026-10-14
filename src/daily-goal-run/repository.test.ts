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

describe("DailyGoalRepository (CC-DG-INV-02 / CC-DG-INV-12 / CC-INV-03)", () => {
  it("registers a goal as running without a session and returns it for a retried confirmation", () => {
    const { repo } = setup();
    expect(repo.create(goal).created).toBe(true);
    const again = repo.create({ ...goal, goalText: "別" });
    expect(again).toMatchObject({ created: false, goal: { goalText: "出荷", status: "running", alertCount: 0 } });
    expect(again.goal.sessionId).toBeUndefined();
    expect(again.goal.alertStreakSince).toBeUndefined();
  });

  it("updates the alert streak only from the state it was read in", () => {
    const { repo } = setup();
    repo.create(goal);
    expect(repo.setAlertState("g1", { streakSince: null, count: 0 }, { streakSince: 10, count: 1 }, 10)).toBe(true);
    expect(repo.setAlertState("g1", { streakSince: null, count: 0 }, { streakSince: 11, count: 1 }, 11)).toBe(false);
    expect(repo.byId("g1")).toMatchObject({ alertStreakSince: 10, alertCount: 1 });
    expect(repo.setAlertState("g1", { streakSince: 10, count: 1 }, { streakSince: null, count: 0 }, 12)).toBe(true);
    expect(repo.byId("g1")?.alertStreakSince).toBeUndefined();
  });

  it("finishes only active goals, including legacy confirmed rows", () => {
    const { repo, db } = setup();
    repo.create(goal);
    db.prepare("UPDATE daily_goals SET status='confirmed' WHERE id='g1'").run();
    expect(repo.listByStatus(["confirmed", "running"]).map((g) => g.id)).toEqual(["g1"]);
    expect(repo.finish("g1", { status: "stopped", reason: "human_stop", by: "u", now: 4 })).toBe(true);
    expect(repo.finish("g1", { status: "deadline", reason: "deadline", now: 5 })).toBe(false);
    expect(repo.setAlertState("g1", { streakSince: null, count: 0 }, { streakSince: 6, count: 1 }, 6)).toBe(false);
  });

  it("stores the judgment of a checkpoint and reads legacy rows without one", () => {
    const { repo } = setup();
    repo.create(goal);
    const judgment = { verdict: "behind" as const, reason: "遅い", acceptance: [{ item: "A", outlook: "at_risk" as const, refs: [] }] };
    repo.addCheckpoint({ id: "old", goalId: "g1", at: 5, kind: "progress", evidence: { items: [], taskStatuses: {}, unavailable: [] }, progress: true, report: null, decision: "go", judgment: null });
    repo.addCheckpoint({ id: "cp", goalId: "g1", at: 10, kind: "judgment", evidence: { items: [], taskStatuses: {}, unavailable: [] }, progress: false, report: null, decision: "go", judgment });
    expect(repo.lastCheckpoint("g1")).toMatchObject({ kind: "judgment", judgment });
    expect(repo.checkpoints("g1")[0]?.judgment).toBeNull();
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

  it("never creates a second goal from the same post and keeps acceptance progress", () => {
    const { repo } = setup();
    expect(repo.create({ ...goal, sourceMessageId: "m1" }).created).toBe(true);
    expect(repo.create({ ...goal, id: "g2", sourceMessageId: "m1" })).toMatchObject({ created: false, goal: { id: "g1" } });
    expect(repo.bySourceMessage("m1")?.id).toBe("g1");
    repo.setAcceptanceProgress("g1", { A: ["commit:a"] }, 2);
    expect(repo.byId("g1")?.acceptanceProgress).toEqual({ A: ["commit:a"] });
    expect(repo.onDate("2026-10-10").map((g) => g.id)).toEqual(["g1"]);
  });

  it("adds the new columns to tables created by the first version", () => {
    const db = new Database(":memory:"); databases.push(db);
    db.exec("CREATE TABLE daily_goals (id TEXT PRIMARY KEY, date TEXT NOT NULL, project TEXT NOT NULL, repo_path TEXT NOT NULL, goal_text TEXT NOT NULL, acceptance TEXT NOT NULL, actio_task_ids TEXT NOT NULL, permissions TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', session_id TEXT, run_id TEXT, launch_state TEXT NOT NULL DEFAULT 'none', launched_at INTEGER, launch_error TEXT, next_launch_at INTEGER, stop_reason TEXT, stopped_by TEXT, remaining TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE daily_goal_checkpoints (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, evidence TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, report TEXT, decision TEXT NOT NULL DEFAULT 'pending')");
    const repo = new DailyGoalRepository(db);
    expect(repo.create({ ...goal, sourceMessageId: "m9" }).goal).toMatchObject({ sourceMessageId: "m9", alertCount: 0 });
    repo.addCheckpoint({ id: "cp", goalId: "g1", at: 1, kind: "judge_failed", evidence: { items: [], taskStatuses: {}, unavailable: [] }, progress: false, report: "x", decision: "go", judgment: null });
    expect(repo.lastCheckpoint("g1")?.kind).toBe("judge_failed");
  });
});
