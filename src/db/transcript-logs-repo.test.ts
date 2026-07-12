import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TranscriptLogsRepo } from "./transcript-logs-repo.js";

let db: ReturnType<typeof makeTestDb>;
let repo: TranscriptLogsRepo;

beforeEach(() => {
  db = makeTestDb();
  repo = new TranscriptLogsRepo(db);
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
