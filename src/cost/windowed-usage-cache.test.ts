import { describe, expect, it } from "vitest";
import { makeCachedSessionWindowReader } from "./windowed-usage-cache.js";
import type { SessionRow } from "../shared/types.js";
import type { UsageWindow } from "./windowed-usage.js";

const NOW_SEC = 1_800_000_000;

function session(id: string, provider = "claude-code"): SessionRow {
  return {
    id,
    provider,
    repo_path: "E:/Document/Ars",
  } as SessionRow;
}

function windows(startSec = NOW_SEC - 3600, endSec = NOW_SEC): UsageWindow[] {
  return [{ key: "d", startSec, endSec }];
}

/** claude-code 形式の usage 行を作る (timestamp は窓内)。 */
function usageLine(id: string, tokens: number): string {
  return JSON.stringify({
    timestamp: new Date((NOW_SEC - 60) * 1000).toISOString(),
    message: { id, usage: { input_tokens: tokens, output_tokens: 0 } },
  });
}

describe("makeCachedSessionWindowReader", () => {
  it("ファイル不変 (mtime+size 一致) なら再読みせず memo を返す", () => {
    let reads = 0;
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => "/log/a.jsonl",
      statFile: () => ({ mtimeMs: 111, size: 10 }),
      readLogLines: () => {
        reads++;
        return [usageLine("m1", 42)];
      },
    });
    const s = session("s1");
    expect(reader(s, windows())).toEqual({ d: 42 });
    expect(reader(s, windows())).toEqual({ d: 42 });
    expect(reader(s, windows())).toEqual({ d: 42 });
    expect(reads).toBe(1);
  });

  it("end 境界が前進しても start 境界が同じなら memo が効く (append-only 前提)", () => {
    let reads = 0;
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => "/log/a.jsonl",
      statFile: () => ({ mtimeMs: 111, size: 10 }),
      readLogLines: () => {
        reads++;
        return [usageLine("m1", 5)];
      },
    });
    const s = session("s1");
    reader(s, windows(NOW_SEC - 3600, NOW_SEC));
    reader(s, windows(NOW_SEC - 3600, NOW_SEC + 60)); // now が進んだだけ
    expect(reads).toBe(1);
  });

  it("ファイル変化 (mtime/size) で再読みする", () => {
    let reads = 0;
    let st = { mtimeMs: 111, size: 10 };
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => "/log/a.jsonl",
      statFile: () => st,
      readLogLines: () => {
        reads++;
        return [usageLine("m1", 5), ...(reads > 1 ? [usageLine("m2", 7)] : [])];
      },
    });
    const s = session("s1");
    expect(reader(s, windows())).toEqual({ d: 5 });
    st = { mtimeMs: 222, size: 20 };
    expect(reader(s, windows())).toEqual({ d: 12 });
    expect(reads).toBe(2);
  });

  it("start 境界の変化 (日付ロール) で再計算する", () => {
    let reads = 0;
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => "/log/a.jsonl",
      statFile: () => ({ mtimeMs: 111, size: 10 }),
      readLogLines: () => {
        reads++;
        return [usageLine("m1", 5)];
      },
    });
    const s = session("s1");
    reader(s, windows(NOW_SEC - 3600, NOW_SEC));
    reader(s, windows(NOW_SEC - 60, NOW_SEC)); // 窓頭が動いた
    expect(reads).toBe(2);
  });

  it("パス解決は session id で cache し、 ファイル消失時のみ再解決する", () => {
    let resolves = 0;
    let alive = true;
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => {
        resolves++;
        return `/log/v${resolves}.jsonl`;
      },
      statFile: () => (alive ? { mtimeMs: 111, size: 10 } : null),
      readLogLines: () => [usageLine("m1", 5)],
    });
    const s = session("s1");
    reader(s, windows());
    reader(s, windows());
    expect(resolves).toBe(1);
    // 解決先が消えた → 再解決が走る (stat は以後 null のままなので 0 を返す)。
    alive = false;
    expect(reader(s, windows())).toEqual({ d: 0 });
    expect(resolves).toBe(2);
  });

  it("未解決 (ログ無し) は TTL 内は再解決しない", () => {
    let resolves = 0;
    let nowMs = 1_000_000;
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => {
        resolves++;
        return null;
      },
      statFile: () => null,
      readLogLines: () => [],
      now: () => nowMs,
    });
    const s = session("s1");
    expect(reader(s, windows())).toEqual({ d: 0 });
    expect(reader(s, windows())).toEqual({ d: 0 });
    expect(resolves).toBe(1);
    nowMs += 61_000; // NEGATIVE_TTL_MS (60s) 経過
    reader(s, windows());
    expect(resolves).toBe(2);
  });

  it("未知 provider は I/O せず 0 を返す", () => {
    let resolves = 0;
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => {
        resolves++;
        return "/log/a.jsonl";
      },
    });
    expect(reader(session("s1", "gemini-cli"), windows())).toEqual({ d: 0 });
    expect(resolves).toBe(0);
  });

  it("memo はコピーを返す (呼び出し側の破壊が cache を汚さない)", () => {
    const reader = makeCachedSessionWindowReader({
      resolveLogPath: () => "/log/a.jsonl",
      statFile: () => ({ mtimeMs: 111, size: 10 }),
      readLogLines: () => [usageLine("m1", 5)],
    });
    const s = session("s1");
    const first = reader(s, windows());
    first.d = 999;
    expect(reader(s, windows())).toEqual({ d: 5 });
  });
});
