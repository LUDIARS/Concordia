import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { TranscriptLogsRepo } from "../src/db/transcript-logs-repo.js";

function fresh() {
  const db = makeTestDb();
  return { db, repo: new TranscriptLogsRepo(db) };
}

describe("TranscriptLogsRepo", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("insert は新規 frame を保存し true を返す", () => {
    const ok = env.repo.insert({
      session_id: "s1",
      seq: 0,
      ts: 1000,
      kind: "text",
      payload: { role: "user", text: "hello" },
    });
    expect(ok).toBe(true);
    expect(env.repo.countBySession("s1")).toBe(1);
  });

  it("同 (session_id, seq) の重複 insert は no-op で false を返す (冪等)", () => {
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { a: 1 } });
    const second = env.repo.insert({
      session_id: "s1",
      seq: 0,
      ts: 2000, // 違う ts でも seq が同じなら ignore
      kind: "text",
      payload: { a: 2 },
    });
    expect(second).toBe(false);
    expect(env.repo.countBySession("s1")).toBe(1);
    // 元の payload が残っている (上書きしない)
    const entries = env.repo.listBySession("s1");
    expect(entries[0].payload).toEqual({ a: 1 });
  });

  it("listBySession は ts ASC, seq ASC で並ぶ", () => {
    env.repo.insert({ session_id: "s1", seq: 2, ts: 1000, kind: "text", payload: { i: 2 } });
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { i: 0 } });
    env.repo.insert({ session_id: "s1", seq: 1, ts: 999, kind: "text", payload: { i: 1 } });
    const list = env.repo.listBySession("s1");
    expect(list.map((e) => (e.payload as { i: number }).i)).toEqual([1, 0, 2]);
  });

  it("session_id でフィルタされる (他 session の frame は混ざらない)", () => {
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { s: "1" } });
    env.repo.insert({ session_id: "s2", seq: 0, ts: 1000, kind: "text", payload: { s: "2" } });
    expect(env.repo.countBySession("s1")).toBe(1);
    expect(env.repo.countBySession("s2")).toBe(1);
    const list1 = env.repo.listBySession("s1");
    expect(list1).toHaveLength(1);
    expect((list1[0].payload as { s: string }).s).toBe("1");
  });

  it("since_id で incremental tail (id > since_id の行のみ)", () => {
    for (let i = 0; i < 5; i++) {
      env.repo.insert({ session_id: "s1", seq: i, ts: 1000 + i, kind: "text", payload: { i } });
    }
    const first = env.repo.listBySession("s1", { limit: 2 });
    expect(first).toHaveLength(2);
    const last = first[first.length - 1];
    const next = env.repo.listBySession("s1", { since_id: last.id, limit: 10 });
    expect(next).toHaveLength(3);
    expect(next[0].seq).toBe(2);
  });

  it("limit はデフォルト 200 / 上限 1000 にクランプされる", () => {
    for (let i = 0; i < 50; i++) {
      env.repo.insert({ session_id: "s1", seq: i, ts: 1000 + i, kind: "text", payload: { i } });
    }
    expect(env.repo.listBySession("s1").length).toBe(50); // < 200 なので全件
    expect(env.repo.listBySession("s1", { limit: 5 })).toHaveLength(5);
    // 異常値: 0/負数は default 200 に
    expect(env.repo.listBySession("s1", { limit: 0 })).toHaveLength(50);
    expect(env.repo.listBySession("s1", { limit: -1 })).toHaveLength(50);
  });

  it("payload は JSON 化されて入る / 取得時は parse 済 unknown で返る", () => {
    const complex = { role: "assistant", text: "long…", nested: { a: [1, 2, 3] } };
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: complex });
    const list = env.repo.listBySession("s1");
    expect(list[0].payload).toEqual(complex);
  });

  it("deleteOlderThan で古い frame を削除できる (purge 用)", () => {
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { i: 0 } });
    env.repo.insert({ session_id: "s1", seq: 1, ts: 2000, kind: "text", payload: { i: 1 } });
    env.repo.insert({ session_id: "s1", seq: 2, ts: 3000, kind: "text", payload: { i: 2 } });
    const removed = env.repo.deleteOlderThan("s1", 2500);
    expect(removed).toBe(2);
    expect(env.repo.countBySession("s1")).toBe(1);
  });
});
