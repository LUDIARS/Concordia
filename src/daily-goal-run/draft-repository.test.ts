import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DailyGoalDraftRepository } from "./draft-repository.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() { const db = new Database(":memory:"); databases.push(db); return new DailyGoalDraftRepository(db); }
const input = { id: "d1", businessDate: "2026-10-10", sourceMessageId: "m1", authorUserId: "u", guildId: "g", channelId: "c", textParts: ["Cc のなにか"], now: 1 };

describe("DailyGoalDraftRepository (2. 下書きと聞き返し / CC-DG-INV-02)", () => {
  it("keeps one draft per post and returns it on redelivery", () => {
    const drafts = setup();
    expect(drafts.create(input).created).toBe(true);
    expect(drafts.create({ ...input, id: "d2" })).toMatchObject({ created: false, draft: { id: "d1", status: "open" } });
  });

  it("saves readings, links the thread once and registers only once", () => {
    const drafts = setup();
    drafts.create(input);
    expect(drafts.saveReading("d1", { textParts: ["a", "b"], extracted: null, missing: ["goal"], now: 2 })).toBe(true);
    drafts.setThread("d1", "t1", 3);
    drafts.setThread("d1", "t2", 4);
    expect(drafts.byThread("t1")).toMatchObject({ id: "d1", textParts: ["a", "b"], missing: ["goal"] });
    expect(drafts.markRegistered("d1", "g1", 5)).toBe(true);
    expect(drafts.markRegistered("d1", "g2", 6)).toBe(false);
    expect(drafts.saveReading("d1", { textParts: ["c"], extracted: null, missing: [], now: 7 })).toBe(false);
    expect(drafts.byId("d1")).toMatchObject({ status: "registered", goalId: "g1" });
  });

  it("expires open drafts at the deadline and lists dates with open drafts", () => {
    const drafts = setup();
    drafts.create(input);
    expect(drafts.openDates()).toEqual(["2026-10-10"]);
    expect(drafts.expireOn("2026-10-10", 9)).toBe(1);
    expect(drafts.onDate("2026-10-10", ["expired"])).toHaveLength(1);
    expect(drafts.openDates()).toEqual([]);
  });
});
