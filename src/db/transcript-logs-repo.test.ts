import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TranscriptLogsRepo } from "./transcript-logs-repo.js";

let db: ReturnType<typeof makeTestDb>;
let repo: TranscriptLogsRepo;

beforeEach(() => {
  db = makeTestDb();
  repo = new TranscriptLogsRepo(db);
});

afterEach(() => {
  // DB close (registerCleanup 側) より先に、保留中の setImmediate flush を
  // 止めてハンドル参照を手放す。 呼ばないと閉じた DB へ flush が飛んで落ちる。
  repo.close();
});

function add(session_id: string, seq: number, kind = "text") {
  repo.insert({ session_id, seq, ts: seq, kind, payload: { text: `f${seq}` } });
}

describe("TranscriptLogsRepo.maxId", () => {
  it("frame が無ければ 0 を返す", () => {
    expect(repo.maxId("s1")).toBe(0);
  });

  it("セッションの最大 row id を返す (別セッションは混ざらない)", () => {
    add("s1", 1);
    add("s1", 2);
    add("s2", 1);
    const max1 = repo.maxId("s1");
    // s1 の 2 frame のうち後勝ちの id が返る。 s2 の行には影響されない。
    expect(max1).toBeGreaterThan(0);
    expect(repo.listBySession("s1", { since_id: max1 })).toHaveLength(0);
    expect(repo.listBySession("s1", { since_id: max1 - 1 })).toHaveLength(1);
  });
});

describe("TranscriptLogsRepo.listBySession tail", () => {
  it("returns the latest limited frames in chronological order", () => {
    for (let i = 1; i <= 5; i += 1) add("s1", i);
    add("s2", 100);

    expect(repo.listBySession("s1", { limit: 2, tail: true }).map((r) => r.seq)).toEqual([4, 5]);
  });

  it("treats since_id as incremental even when tail is also requested", () => {
    for (let i = 1; i <= 5; i += 1) add("s1", i);
    const firstTwo = repo.listBySession("s1", { limit: 2 });
    const sinceId = firstTwo[firstTwo.length - 1].id;

    expect(repo.listBySession("s1", { since_id: sinceId, limit: 2, tail: true }).map((r) => r.seq)).toEqual([3, 4]);
  });
});

describe("TranscriptLogsRepo.insert idempotency", () => {
  it("新規 frame は true / 行が 1 行だけ増える", () => {
    expect(repo.insert({ session_id: "s1", seq: 0, ts: 1, kind: "raw", payload: { a: 1 } })).toBe(true);
    expect(repo.countBySession("s1")).toBe(1);
  });

  it("同 (session_id, seq) の再送 (at-least-once) は冪等成功として true を返す", () => {
    // Lictor sink は timeout 後に同 seq で再送する。 1 回目が実は届いていた場合の
    // 重複 POST を false で返すと requirePersisted な書き手が死ぬ (2026-07-12 実障害)。
    repo.insert({ session_id: "s1", seq: 0, ts: 1, kind: "raw", payload: { a: 1 } });
    expect(repo.insert({ session_id: "s1", seq: 0, ts: 2, kind: "raw", payload: { a: 1 } })).toBe(true);
    // 行は増えず、 先勝ちの内容が保持される。
    expect(repo.countBySession("s1")).toBe(1);
    expect(repo.listBySession("s1")[0].ts).toBe(1);
  });

  it("別セッションの同 seq は独立に挿入される", () => {
    expect(repo.insert({ session_id: "s1", seq: 0, ts: 1, kind: "raw", payload: null })).toBe(true);
    expect(repo.insert({ session_id: "s2", seq: 0, ts: 1, kind: "raw", payload: null })).toBe(true);
    expect(repo.countBySession("s1")).toBe(1);
    expect(repo.countBySession("s2")).toBe(1);
  });
});

describe("TranscriptLogsRepo async flush", () => {
  it("insert はキュー投入のみで同期的に DB へ書かない (即時 countBySession は 0)", () => {
    // insert() が同期 db.prepare().run() を直接呼ばず setImmediate に委譲していることの
    // 回帰検知。 flushSync を経由しない生カウントで確認する。
    repo.insert({ session_id: "s1", seq: 0, ts: 1, kind: "raw", payload: null });
    const rawCount = (db.prepare(`SELECT COUNT(*) AS n FROM transcript_logs`).get() as { n: number }).n;
    expect(rawCount).toBe(0);
  });

  it("flushSync 後は queued frame が DB に反映される", () => {
    repo.insert({ session_id: "s1", seq: 0, ts: 1, kind: "raw", payload: { a: 1 } });
    repo.insert({ session_id: "s1", seq: 1, ts: 2, kind: "raw", payload: { a: 2 } });
    repo.flushSync();
    expect(repo.countBySession("s1")).toBe(2);
  });

  it("大量 insert (バッチサイズ超過) でも flushSync で全件反映される (順序逆転なし)", () => {
    const total = 450; // FLUSH_BATCH_SIZE(200) をまたぐ件数
    for (let i = 0; i < total; i += 1) {
      repo.insert({ session_id: "s1", seq: i, ts: i, kind: "raw", payload: { i } });
    }
    repo.flushSync();
    const entries = repo.listBySession("s1", { limit: total });
    expect(entries).toHaveLength(total);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(entries.every((entry, index) => index === 0 || entry.id > entries[index - 1].id)).toBe(true);
  });

  it("setImmediate ごとに最大 200 件ずつ flush する", async () => {
    for (let i = 0; i < 450; i += 1) {
      repo.insert({ session_id: "s1", seq: i, ts: i, kind: "raw", payload: null });
    }
    const rawCount = (): number => (
      db.prepare(`SELECT COUNT(*) AS n FROM transcript_logs`).get() as { n: number }
    ).n;

    await new Promise((resolve) => setImmediate(resolve));
    expect(rawCount()).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rawCount()).toBe(400);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rawCount()).toBe(450);
  });

  it("listBySession / maxId / tsSpan / countBySession はいずれも未 flush の frame を読み逃さない", () => {
    repo.insert({ session_id: "s1", seq: 0, ts: 10, kind: "raw", payload: null });
    expect(repo.countBySession("s1")).toBe(1);
    expect(repo.maxId("s1")).toBeGreaterThan(0);
    expect(repo.tsSpan("s1")).toEqual({ first_ts: 10, last_ts: 10 });
    expect(repo.listBySession("s1")).toHaveLength(1);
  });

  it("flush 失敗時は queued frame を保持し、次の flush で再試行できる", () => {
    db.exec(`
      CREATE TRIGGER reject_transcript_insert
      BEFORE INSERT ON transcript_logs
      BEGIN
        SELECT RAISE(ABORT, 'temporary failure');
      END
    `);
    repo.insert({ session_id: "s1", seq: 0, ts: 1, kind: "raw", payload: null });
    expect(() => repo.flushSync()).toThrow("temporary failure");

    db.exec(`DROP TRIGGER reject_transcript_insert`);
    repo.flushSync();
    expect(repo.countBySession("s1")).toBe(1);
  });

  it("JSON 化できない payload は非同期 callback へ持ち越さず insert で拒否する", () => {
    const payload: { self?: unknown } = {};
    payload.self = payload;
    expect(() => repo.insert({
      session_id: "s1",
      seq: 0,
      ts: 1,
      kind: "raw",
      payload,
    })).toThrow();
  });

  it("close は queued frame を書き切り、以後の insert を拒否する", () => {
    repo.insert({ session_id: "s1", seq: 0, ts: 1, kind: "raw", payload: null });
    repo.close();
    const rawCount = (db.prepare(`SELECT COUNT(*) AS n FROM transcript_logs`).get() as { n: number }).n;
    expect(rawCount).toBe(1);
    expect(() => repo.insert({
      session_id: "s1",
      seq: 1,
      ts: 2,
      kind: "raw",
      payload: null,
    })).toThrow("closed");
  });
});
