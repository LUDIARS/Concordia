import { describe, expect, it } from "vitest";
import {
  accumulateClaudeCostLines,
  codexTotalFromLines,
  makeCachedChannelCostReader,
  type ChannelCostCacheIo,
} from "./channel-cost-cache.js";
import type { SessionRow } from "../shared/types.js";

function session(id: string, provider: string): SessionRow {
  return { id, provider, repo_path: "E:/Document/Ars" } as SessionRow;
}

function claudeUsageLine(id: string, input: number, output: number): string {
  return JSON.stringify({ message: { id, usage: { input_tokens: input, output_tokens: output } } });
}

function codexCountLine(total: number, lastInput: number): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: lastInput },
      },
    },
  });
}

function makeIo(over: Partial<ChannelCostCacheIo>): ChannelCostCacheIo {
  return {
    resolveLogPath: () => "/log/a.jsonl",
    statFile: () => ({ mtimeMs: 1, size: 100 }),
    readTail: () => [],
    readFull: () => [],
    readAppended: () => ({ lines: [], nextOffset: 0 }),
    now: () => 0,
    ...over,
  };
}

describe("codexTotalFromLines / accumulateClaudeCostLines", () => {
  it("codex: token_count の最大 total を返す (無ければ null)", () => {
    expect(codexTotalFromLines([codexCountLine(100, 10), codexCountLine(250, 20)])).toBe(250);
    expect(codexTotalFromLines(["{}", "not-json"])).toBe(null);
  });

  it("claude: message.id で dedup しつつ合算する", () => {
    const st = { path: "p", offset: 0, total: 0, seen: new Set<string>() };
    accumulateClaudeCostLines(
      [claudeUsageLine("m1", 10, 5), claudeUsageLine("m1", 10, 5), claudeUsageLine("m2", 1, 2)],
      st,
    );
    expect(st.total).toBe(18);
  });
});

describe("makeCachedChannelCostReader", () => {
  it("codex cost: tail から取り、 ファイル不変なら再読みしない", () => {
    let tails = 0;
    const reader = makeCachedChannelCostReader(makeIo({
      readTail: () => {
        tails++;
        return [codexCountLine(500, 30)];
      },
    }));
    const s = session("c1", "codex-cli");
    expect(reader.cost(s)).toBe(500);
    expect(reader.cost(s)).toBe(500);
    expect(tails).toBe(1);
  });

  it("context: tail で決まらなければ全読みへフォールバック", () => {
    let fulls = 0;
    const reader = makeCachedChannelCostReader(makeIo({
      readTail: () => ["{}"],
      readFull: () => {
        fulls++;
        return [codexCountLine(500, 77)];
      },
    }));
    expect(reader.context(session("c1", "codex-cli"))).toBe(77);
    expect(fulls).toBe(1);
  });

  it("claude cost: 追記分だけ増分合算する", () => {
    let snap = { mtimeMs: 1, size: 10 };
    const chunks: Record<number, { lines: string[]; nextOffset: number }> = {
      0: { lines: [claudeUsageLine("m1", 10, 5)], nextOffset: 10 },
      10: { lines: [claudeUsageLine("m2", 100, 50)], nextOffset: 20 },
    };
    const reader = makeCachedChannelCostReader(makeIo({
      statFile: () => snap,
      readAppended: (_p, offset) => chunks[offset] ?? { lines: [], nextOffset: offset },
    }));
    const s = session("cl1", "claude-code");
    expect(reader.cost(s)).toBe(15);
    expect(reader.cost(s)).toBe(15); // 不変 → 再読みなし
    snap = { mtimeMs: 2, size: 20 }; // 追記
    expect(reader.cost(s)).toBe(165);
  });

  it("claude cost: ファイル縮小 (ローテート) で作り直す", () => {
    let snap = { mtimeMs: 1, size: 20 };
    const reader = makeCachedChannelCostReader(makeIo({
      statFile: () => snap,
      readAppended: (_p, offset) =>
        offset === 0
          ? { lines: [claudeUsageLine(`m${snap.size}`, snap.size, 0)], nextOffset: snap.size }
          : { lines: [], nextOffset: offset },
    }));
    const s = session("cl1", "claude-code");
    expect(reader.cost(s)).toBe(20);
    snap = { mtimeMs: 2, size: 5 }; // 縮んだ = 別ファイルに差し替わった
    expect(reader.cost(s)).toBe(5);
  });

  it("ログ未解決は null / 0 を返し、 負キャッシュ TTL 内は再解決しない", () => {
    let resolves = 0;
    let nowMs = 0;
    const reader = makeCachedChannelCostReader(makeIo({
      resolveLogPath: () => {
        resolves++;
        return null;
      },
      statFile: () => null,
      now: () => nowMs,
    }));
    const s = session("c1", "codex-cli");
    expect(reader.context(s)).toBe(null);
    expect(reader.cost(s)).toBe(0);
    expect(resolves).toBe(1);
    nowMs = 61_000;
    reader.context(s);
    expect(resolves).toBe(2);
  });

  it("未知 provider は I/O ゼロで null / 0", () => {
    let resolves = 0;
    const reader = makeCachedChannelCostReader(makeIo({
      resolveLogPath: () => {
        resolves++;
        return "/log/a.jsonl";
      },
    }));
    expect(reader.context(session("g1", "gemini-cli"))).toBe(null);
    expect(reader.cost(session("g1", "gemini-cli"))).toBe(0);
    expect(resolves).toBe(0);
  });
});
