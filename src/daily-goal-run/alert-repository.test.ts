import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DailyGoalAlertRepository } from "./alert-repository.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() { const db = new Database(":memory:"); databases.push(db); return { db, alerts: new DailyGoalAlertRepository(db) }; }
const alert = { id: "a1", goalId: "g1", at: 10, kind: "first" as const, verdict: "behind" as const, text: "遅れ気味", mentionUserId: "u" };

describe("DailyGoalAlertRepository (CC-DG-INV-12 / CC-INV-03)", () => {
  it("delivers through a single intent and never re-sends an unknown result", () => {
    const { alerts, db } = setup();
    alerts.add(alert);
    alerts.add({ ...alert, text: "重複" });
    expect(alerts.pending(0)).toHaveLength(1);
    expect(alerts.claim("a1")).toBe(true);
    expect(alerts.claim("a1")).toBe(false);
    alerts.unknownResult("a1", "socket closed");
    expect(new DailyGoalAlertRepository(db).pending(1_000_000)).toEqual([]);
    expect(alerts.byGoal("g1")).toMatchObject([{ status: "unknown", text: "遅れ気味", lastError: "socket closed" }]);
  });

  it("retries after a definite rejection and records the sent message", () => {
    const { alerts } = setup();
    alerts.add(alert);
    alerts.claim("a1");
    alerts.rejected("a1", "Missing Access", 100);
    expect(alerts.pending(100)).toEqual([]);
    expect(alerts.pending(100 + 60_000)).toHaveLength(1);
    expect(alerts.claim("a1")).toBe(true);
    alerts.sent("a1", "m1");
    expect(alerts.pending(10_000_000)).toEqual([]);
    expect(alerts.byGoal("g1")[0]).toMatchObject({ status: "sent", messageId: "m1", lastError: null });
  });
});
