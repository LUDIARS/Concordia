/**
 * ダイジェストと催促。 「気づく面」を作るのが目的なので、 出す/出さないの判断が要。
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { InboxNoticeRepo } from "../db/inbox-notice-repo.js";
import { buildDigestText, formatElapsed } from "./digest.js";
import type { InboxItem } from "./read-model.js";
import { pendingDigestWindows, startInboxNotifier, type DigestWindow } from "./notifier.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function item(over: Partial<InboxItem> = {}): InboxItem {
  return { key: "ask-card:1", kind: "ask-card", summary: "答えて", raisedAt: 0, ...over };
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

/** 指定の日付・時刻 (ローカル) の epoch ms。 窓の判定はローカルタイム基準。 */
function localTime(day: number, hour: number, minute = 0): number {
  return new Date(2026, 8, day, hour, minute, 0, 0).getTime();
}

function addCard(db: Database.Database, question: string, tsSec: number): void {
  db.prepare(`
    INSERT INTO discord_pending_questions(session_id, question, options_json, answered_at, ts)
    VALUES ('sess-1', ?, '[]', NULL, ?)
  `).run(question, tsSec);
}

describe("ダイジェスト本文", () => {
  it("0 件なら出さない", () => {
    expect(buildDigestText([], 0)).toBeNull();
  });

  it("件数・種別内訳・最古 3 件を載せる", () => {
    const now = 10 * DAY;
    const items = [
      item({ key: "a:1", summary: "いちばん古い", raisedAt: now - 3 * DAY }),
      item({ key: "a:2", summary: "2 番目", raisedAt: now - 2 * DAY }),
      item({ key: "a:3", summary: "3 番目", raisedAt: now - HOUR }),
      item({ key: "c:4", kind: "confirm-pending", summary: "4 番目", raisedAt: now - 60_000 }),
    ];

    const text = buildDigestText(items, now) ?? "";
    expect(text).toContain("未回答 4 件");
    expect(text).toContain("質問カード 3");
    expect(text).toContain("承認待ち 1");
    expect(text).toContain("3日経過");
    expect(text).toContain("いちばん古い");
    // 4 件目は本文に出さず、 残件数だけ示す。
    expect(text).not.toContain("4 番目");
    expect(text).toContain("ほか 1 件");
  });

  it("未信頼の要旨に含まれる platform mention を無効化する", () => {
    const text = buildDigestText([item({ summary: "@everyone <@123456789012345678> <!channel>" })], DAY) ?? "";
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("<@123456789012345678>");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("＠everyone");
  });

  it("経過時間は分・時間・日で丸める", () => {
    expect(formatElapsed(90_000)).toBe("1分");
    expect(formatElapsed(5 * HOUR)).toBe("5時間");
    expect(formatElapsed(3 * DAY + HOUR)).toBe("3日");
  });
});

describe("ダイジェストの窓", () => {
  const last = (morning: number | null, evening: number | null) =>
    new Map<DigestWindow, number | null>([["morning", morning], ["evening", evening]]);

  it("窓が開く前は出さない", () => {
    expect(pendingDigestWindows(localTime(1, 8), last(null, null))).toEqual([]);
  });

  it("その窓で 1 度出したら再度出さない", () => {
    const at = localTime(1, 9, 30);
    expect(pendingDigestWindows(at, last(null, null))).toEqual(["morning"]);
    expect(pendingDigestWindows(at, last(localTime(1, 9, 5), null))).toEqual([]);
  });

  it("前日に出していても翌日の同じ窓では出す", () => {
    expect(pendingDigestWindows(localTime(2, 9, 30), last(localTime(1, 9, 5), null))).toEqual(["morning"]);
  });

  it("Cc が落ちて窓を跨いだら復帰時にまとめて出す", () => {
    // 取りこぼすより、 まとめて 1 回ずつ出すほうがよい。
    expect(pendingDigestWindows(localTime(1, 20), last(null, null))).toEqual(["morning", "evening"]);
  });
});

describe("常駐部", () => {
  function harness(at: number, opts: { enabled?: boolean } = {}) {
    const db = makeDb();
    const posted: string[] = [];
    const notifier = startInboxNotifier({
      db,
      notices: new InboxNoticeRepo(db),
      post: (text) => {
        posted.push(text);
      },
      now: () => at,
      enabled: opts.enabled,
      intervalMs: 60 * 60 * 1000,
    });
    notifier.stop();
    return { db, posted, notifier };
  }

  it("未回答 0 件なら窓が開いていても投稿しない", () => {
    const h = harness(localTime(1, 9, 30));
    expect(h.notifier.runOnce()).toEqual([]);
  });

  it("0 件で消化した窓は、その後に増えても同じ窓で蒸し返さない", () => {
    // 消化しないと、 朝の 0 件が「朝の分」として夕方前に出てしまう。
    const at = localTime(1, 9, 30);
    const h = harness(at);
    h.notifier.runOnce();
    addCard(h.db, "あとから増えた", Math.floor(at / 1000));
    expect(h.notifier.runOnce()).toEqual([]);
  });

  it("未回答があればダイジェストを 1 度だけ出す", () => {
    const at = localTime(1, 9, 30);
    const h = harness(at);
    addCard(h.db, "答えて", Math.floor((at - 2 * HOUR) / 1000));

    expect(h.notifier.runOnce()).toHaveLength(1);
    expect(h.posted[0]).toContain("未回答 1 件");
    expect(h.notifier.runOnce()).toEqual([]);
  });

  it("経過時間では催促しない (時間駆動の催促は撤去した)", () => {
    // 溜まった項目を再起動後に一斉投稿しない。1 通ごとの管理職全員 mention も撤去した。
    // 置き換え先は「人間がそのセッションのチャンネルへ戻ってきたら、そのセッションの分だけ
    // 担当者 1 人へ」(src/inbox/session-return-notice.ts)。
    const at = localTime(2, 14);
    const h = harness(at);
    addCard(h.db, "放置されている", Math.floor((at - 30 * HOUR) / 1000));
    const posted = h.notifier.runOnce();
    expect(posted.filter((text) => text.includes("放置されています"))).toEqual([]);
  });

  it("ダイジェスト投稿失敗時は窓を消化しない", () => {
    const at = localTime(1, 9, 30);
    const db = makeDb();
    addCard(db, "答えて", Math.floor((at - 2 * HOUR) / 1000));
    const notices = new InboxNoticeRepo(db);
    const notifier = startInboxNotifier({
      db,
      notices,
      post: () => { throw new Error("post failed"); },
      now: () => at,
      intervalMs: HOUR,
    });
    notifier.stop();

    expect(() => notifier.runOnce()).toThrow("post failed");
    expect(notices.lastAt("digest:morning")).toBeNull();
  });

  it("深夜帯でもダイジェストの窓は消化する (催促が無くなったので夜だけの分岐は無い)", () => {
    const at = localTime(2, 2);
    const h = harness(at);
    addCard(h.db, "放置されている", Math.floor((at - 30 * HOUR) / 1000));

    expect(h.notifier.runOnce().filter((t) => t.includes("放置されています"))).toEqual([]);
  });

  it("無効なら何も出さない", () => {
    const at = localTime(1, 9, 30);
    const h = harness(at, { enabled: false });
    addCard(h.db, "答えて", Math.floor(at / 1000));
    expect(h.notifier.runOnce()).toEqual([]);
  });
});
