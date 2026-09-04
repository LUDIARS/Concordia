/**
 * 既読・スヌーズの永続化。 **UI 状態であって回答ではない**ことが要点なので、
 * 「client ごとに分かれる」「片方が片方を消さない」を落とさない。
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { InboxItemStateRepo } from "./inbox-item-state-repo.js";

function makeRepo(): InboxItemStateRepo {
  const db = new Database(":memory:");
  applyMigrations(db);
  return new InboxItemStateRepo(db);
}

describe("inbox_item_state", () => {
  it("何も無ければ空", () => {
    expect(makeRepo().allFor("alice").size).toBe(0);
  });

  it("既読は client ごとに分かれる", () => {
    const repo = makeRepo();
    repo.markRead("alice", "ask-card:1", 100);

    expect(repo.allFor("alice").get("ask-card:1")).toEqual({ readAt: 100, snoozedUntil: null });
    expect(repo.allFor("bob").size).toBe(0);
  });

  it("既読とスヌーズは互いを消さない", () => {
    // 別々の操作。 既読を付けたらスヌーズが解けるのでは、 片方が使えない。
    const repo = makeRepo();
    repo.snooze("alice", "ask-card:1", 100, 900);
    repo.markRead("alice", "ask-card:1", 200);
    expect(repo.allFor("alice").get("ask-card:1")).toEqual({ readAt: 200, snoozedUntil: 900 });

    repo.markUnread("alice", "ask-card:1", 300);
    expect(repo.allFor("alice").get("ask-card:1")).toEqual({ readAt: null, snoozedUntil: 900 });
  });

  it("スヌーズは null で解除できる", () => {
    const repo = makeRepo();
    repo.snooze("alice", "ask-card:1", 100, 900);
    repo.snooze("alice", "ask-card:1", 200, null);

    expect(repo.allFor("alice").get("ask-card:1")?.snoozedUntil).toBeNull();
  });

  it("正本から消えた項目の行は捨てる", () => {
    // 回答済みの項目のキーは二度と現れない。 残すと client ごとに単調増加する。
    const repo = makeRepo();
    repo.markRead("alice", "ask-card:1", 100);
    repo.snooze("bob", "ask-card:1", 100, 900);
    repo.markRead("alice", "ask-card:2", 100);

    expect(repo.pruneMissing(new Set(["ask-card:2"]))).toBe(2);
    expect(repo.allFor("alice").size).toBe(1);
    expect(repo.allFor("bob").size).toBe(0);
  });
});
