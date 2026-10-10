import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DailyGoalDayRepository } from "./day-repository.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() { const db = new Database(":memory:"); databases.push(db); return new DailyGoalDayRepository(db); }

describe("DailyGoalDayRepository (7. 通知 / 8. まとめと記載 / CC-INV-03)", () => {
  it("records 目標なし and the reminder intent only once", () => {
    const days = setup();
    expect(days.recordNoGoal("2026-10-10", "u", 1)).toBe(true);
    expect(days.recordNoGoal("2026-10-10", "v", 2)).toBe(false);
    expect(days.get("2026-10-10")).toMatchObject({ noGoalBy: "u", noGoalAt: 1 });
    expect(days.claimReminder("2026-10-11", 3)).toBe(true);
    expect(days.claimReminder("2026-10-11", 4)).toBe(false);
    days.reminderPosted("2026-10-11", "m1", 5);
    expect(days.get("2026-10-11")).toMatchObject({ reminderState: "posted", reminderMessageId: "m1" });
  });

  it("advances the close stages with CAS and skips days without a summary", () => {
    const days = setup();
    days.ensure("2026-10-10", 1);
    expect(days.advanceClose("2026-10-10", "none", "stopping", 2)).toBe(true);
    expect(days.advanceClose("2026-10-10", "none", "stopping", 3)).toBe(false);
    expect(days.saveSummary("2026-10-10", null, 4)).toBe(true);
    expect(days.get("2026-10-10")).toMatchObject({ closeState: "skipped", diaryState: "skipped", noteState: "skipped" });
    expect(days.unfinished()).toEqual([]);
  });

  it("keeps unwritten and unknown journal states for a later retry and resets them for a manual resend", () => {
    const days = setup();
    days.ensure("2026-10-10", 1);
    days.advanceClose("2026-10-10", "none", "stopping", 2);
    days.saveSummary("2026-10-10", { title: "t", markdown: "m" }, 3);
    expect(days.claimJournal("2026-10-10", "diary", 4)).toBe(true);
    days.journalFailed("2026-10-10", "diary", "unknown", "timeout", 100, 5);
    expect(days.claimJournal("2026-10-10", "note", 6)).toBe(true);
    days.journalWritten("2026-10-10", "note", { noteId: "n1", url: "http://memoria/n1" }, 7);
    expect(days.get("2026-10-10")).toMatchObject({ diaryState: "unknown", noteState: "written", noteId: "n1", nextAttemptAt: 100 });
    expect(days.unfinished().map((d) => d.businessDate)).toEqual(["2026-10-10"]);
    expect(days.resetJournal("2026-10-10", 8)).toBe(false);
    days.advanceClose("2026-10-10", "summarized", "journaled", 9);
    expect(days.resetJournal("2026-10-10", 10)).toBe(true);
    expect(days.get("2026-10-10")).toMatchObject({ diaryState: "none", noteState: "none", nextAttemptAt: 0 });
  });
});
