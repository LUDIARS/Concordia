import { describe, expect, it } from "vitest";
import {
  addSeenBounded,
  makeCachedRecentLogTotals,
  SEEN_CAP,
  type LogTotalsCacheIo,
} from "./log-totals-cache.js";

describe("addSeenBounded (dedup 集合のメモリ bound)", () => {
  it("SEEN_CAP を超えたら挿入順で最古を捨て、 size は cap で頭打ち", () => {
    const seen = new Set<string>();
    for (let i = 0; i < SEEN_CAP + 100; i++) addSeenBounded(seen, `id-${i}`);
    expect(seen.size).toBe(SEEN_CAP);
    // 直近 cap 件は残り、 最古 100 件は落ちている。
    expect(seen.has(`id-${SEEN_CAP + 99}`)).toBe(true);
    expect(seen.has("id-0")).toBe(false);
    expect(seen.has("id-99")).toBe(false);
    expect(seen.has("id-100")).toBe(true);
  });

  it("隣接する重複はまだ窓内にあるので dedup が効く", () => {
    const seen = new Set<string>();
    addSeenBounded(seen, "dup");
    // 窓を溢れさせない範囲での重複は has で弾ける。
    expect(seen.has("dup")).toBe(true);
    for (let i = 0; i < SEEN_CAP - 1; i++) addSeenBounded(seen, `x-${i}`);
    expect(seen.has("dup")).toBe(true); // まだ窓内
  });
});

/** 追記可能な in-memory JSONL ファイル群で io を偽装する。 */
function makeFakeIo() {
  const files = new Map<string, { kind: "claude" | "codex"; lines: string[]; mtimeMs: number }>();
  let reads = 0;
  const content = (lines: string[]) => lines.map((l) => l + "\n").join("");
  const io: LogTotalsCacheIo = {
    statFile: (path) => {
      const f = files.get(path);
      if (!f) return null;
      return { mtimeMs: f.mtimeMs, size: Buffer.byteLength(content(f.lines)) };
    },
    readAppended: (path, offset) => {
      const f = files.get(path);
      if (!f) return null;
      reads++;
      const text = content(f.lines);
      const buf = Buffer.from(text);
      if (buf.length <= offset) return { lines: [], nextOffset: offset };
      const chunk = buf.subarray(offset).toString("utf8");
      return {
        lines: chunk.split("\n").filter((l) => l.trim()),
        nextOffset: buf.length,
      };
    },
    enumeratePaths: () => [...files.entries()].map(([path, f]) => ({ path, kind: f.kind })),
  };
  return { files, io, readCount: () => reads };
}

const claudeLine = (id: string, input: number, output: number, cached = 0) =>
  JSON.stringify({ message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached } } });

const codexLine = (total: number) =>
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total } } } });

describe("makeCachedRecentLogTotals", () => {
  it("claude: 追記分だけ増分パースして合算する (dedup 込み)", () => {
    const { files, io, readCount } = makeFakeIo();
    const enumerate = makeCachedRecentLogTotals(io);
    files.set("a.jsonl", { kind: "claude", lines: [claudeLine("m1", 100, 50)], mtimeMs: 1 });

    expect(enumerate(0, 0)).toEqual([{ path: "a.jsonl", total: 150 }]);
    const readsAfterFirst = readCount();

    // 不変なら再読みゼロ
    expect(enumerate(0, 0)).toEqual([{ path: "a.jsonl", total: 150 }]);
    expect(readCount()).toBe(readsAfterFirst);

    // 追記 (dedup 対象の重複 id を含む)
    const f = files.get("a.jsonl")!;
    f.lines.push(claudeLine("m1", 100, 50), claudeLine("m2", 10, 5));
    f.mtimeMs = 2;
    expect(enumerate(0, 0)).toEqual([{ path: "a.jsonl", total: 165 }]);
  });

  it("codex: token_count の最大値を追記から更新する", () => {
    const { files, io } = makeFakeIo();
    const enumerate = makeCachedRecentLogTotals(io);
    files.set("c.jsonl", { kind: "codex", lines: [codexLine(1000), codexLine(2000)], mtimeMs: 1 });
    expect(enumerate(0, 0)).toEqual([{ path: "c.jsonl", total: 2000 }]);

    const f = files.get("c.jsonl")!;
    f.lines.push(codexLine(3500));
    f.mtimeMs = 2;
    expect(enumerate(0, 0)).toEqual([{ path: "c.jsonl", total: 3500 }]);
  });

  it("usage の無いファイルは載せない (旧 enumerate と同じ採否)", () => {
    const { files, io } = makeFakeIo();
    const enumerate = makeCachedRecentLogTotals(io);
    files.set("empty-claude.jsonl", { kind: "claude", lines: [JSON.stringify({ other: 1 })], mtimeMs: 1 });
    files.set("empty-codex.jsonl", { kind: "codex", lines: [JSON.stringify({ type: "other" })], mtimeMs: 1 });
    expect(enumerate(0, 0)).toEqual([]);
  });

  it("claude: cached のみでも記録対象になる", () => {
    const { files, io } = makeFakeIo();
    const enumerate = makeCachedRecentLogTotals(io);
    files.set("cached.jsonl", { kind: "claude", lines: [claudeLine("m1", 0, 0, 500)], mtimeMs: 1 });
    expect(enumerate(0, 0)).toEqual([{ path: "cached.jsonl", total: 0 }]);
  });

  it("縮小 (ローテート) を検知したら 0 から読み直す", () => {
    const { files, io } = makeFakeIo();
    const enumerate = makeCachedRecentLogTotals(io);
    files.set("r.jsonl", {
      kind: "claude",
      lines: [claudeLine("m1", 100, 0), claudeLine("m2", 200, 0)],
      mtimeMs: 1,
    });
    expect(enumerate(0, 0)).toEqual([{ path: "r.jsonl", total: 300 }]);

    files.set("r.jsonl", { kind: "claude", lines: [claudeLine("m9", 40, 2)], mtimeMs: 2 });
    expect(enumerate(0, 0)).toEqual([{ path: "r.jsonl", total: 42 }]);
  });
});
