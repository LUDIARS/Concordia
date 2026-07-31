import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { TranscriptLogsRepo } from "../src/db/transcript-logs-repo.js";
import { readUsageFrames } from "../src/cost/log-usage.js";

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

  it("同 (session_id, seq) の重複 insert は no-op だが冪等成功として true を返す", () => {
    // Lictor sink の at-least-once 再送 (timeout 後の同 seq 再POST) を
    // requirePersisted な書き手が成功として扱えるようにする (2026-07-12 実障害)。
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { a: 1 } });
    const second = env.repo.insert({
      session_id: "s1",
      seq: 0,
      ts: 2000, // 違う ts でも seq が同じなら ignore
      kind: "text",
      payload: { a: 2 },
    });
    expect(second).toBe(true);
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
    // (a) 250 行挿入 → limit 未指定でちょうど 200 件返ること (デフォルト 200 クランプ)
    for (let i = 0; i < 250; i++) {
      env.repo.insert({ session_id: "s2", seq: i, ts: 1000 + i, kind: "text", payload: { i } });
    }
    expect(env.repo.listBySession("s2")).toHaveLength(200);

    // (b) 1100 行挿入 → limit: 9999 指定でちょうど 1000 件返ること (上限 1000 クランプ)
    for (let i = 0; i < 1100; i++) {
      env.repo.insert({ session_id: "s3", seq: i, ts: 1000 + i, kind: "text", payload: { i } });
    }
    expect(env.repo.listBySession("s3", { limit: 9999 })).toHaveLength(1000);

    // 既存の小規模テスト (< 200 なら全件, 任意 limit, 異常値)
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

  it("listUsagePayloads は codex_usage frame だけを新しい順に返す", () => {
    // kind は送信側 (Satelles) が決める自由文字列なので、特定 kind に依存しない。
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { role: "user", text: "hi" } });
    env.repo.insert({
      session_id: "s1", seq: 1, ts: 1001, kind: "raw",
      payload: { type: "codex_usage", input_tokens: 100, output_tokens: 30, total_tokens: 130 },
    });
    env.repo.insert({
      session_id: "s1", seq: 2, ts: 1002, kind: "codex",
      payload: { type: "codex_usage", input_tokens: 300, output_tokens: 50, total_tokens: 350 },
    });
    // 他 session の usage は混ざらない
    env.repo.insert({
      session_id: "s2", seq: 0, ts: 1003, kind: "raw",
      payload: { type: "codex_usage", input_tokens: 900, output_tokens: 90, total_tokens: 990 },
    });

    const payloads = env.repo.listUsagePayloads("s1");
    expect(payloads).toHaveLength(2);
    expect((payloads[0] as { total_tokens: number }).total_tokens).toBe(350); // 新しい順
    // 集計側と繋いだときにスレッド累積の最大値が採れること
    expect(readUsageFrames(payloads)).toEqual({ input: 300, cached: 0, output: 50, total: 350 });
  });

  it("listUsagePayloads は本文が codex_usage に言及するだけの frame を拾わない", () => {
    // type 以外のキーの値が codex_usage なだけの frame (例: 同名の tool 呼び出し)。
    // readUsageFrames は type を見て捨てるが、 SQL 側で拾ってしまうと limit の窓を
    // 埋めて実 usage frame を追い出す (= 過少計上) ので、 key ごと絞って除外する。
    env.repo.insert({
      session_id: "s1", seq: 0, ts: 1000, kind: "tool-use",
      payload: { type: "tool_use", name: "codex_usage" },
    });
    env.repo.insert({
      session_id: "s1", seq: 1, ts: 1001, kind: "raw",
      payload: { type: "codex_usage", input_tokens: 100, output_tokens: 30, total_tokens: 130 },
    });

    const payloads = env.repo.listUsagePayloads("s1");
    expect(payloads).toHaveLength(1);
    expect(readUsageFrames(payloads)).toEqual({ input: 100, cached: 0, output: 30, total: 130 });
  });

  it("listUsagePayloads は usage frame が無ければ空 (0 を実測値と偽らない)", () => {
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { text: "no usage here" } });
    expect(env.repo.listUsagePayloads("s1")).toEqual([]);
    expect(readUsageFrames(env.repo.listUsagePayloads("s1"))).toBeNull();
  });

  it("purgeOlderThan で全 session の古い frame を削除できる", () => {
    env.repo.insert({ session_id: "s1", seq: 0, ts: 1000, kind: "text", payload: { i: 0 } });
    env.repo.insert({ session_id: "s1", seq: 1, ts: 2000, kind: "text", payload: { i: 1 } });
    env.repo.insert({ session_id: "s1", seq: 2, ts: 3000, kind: "text", payload: { i: 2 } });
    env.repo.insert({ session_id: "s2", seq: 0, ts: 1000, kind: "text", payload: { i: 3 } });
    const removed = env.repo.purgeOlderThan(2500);
    expect(removed).toBe(3);
    expect(env.repo.countBySession("s1")).toBe(1);
    expect(env.repo.countBySession("s2")).toBe(0);
  });
});
