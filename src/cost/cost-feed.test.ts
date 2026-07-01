/**
 * cost-feed の永続化 (JSONL) と getCostFeed の解決ロジックのテスト。
 * - createJsonlCostFeed: 親ディレクトリを作って record→flush→read が往復する
 * - getCostFeed: 既定で永続化 / env パス上書き / "" で in-memory オプトアウト
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlCostFeed,
  readCostEntries,
  getCostFeed,
  _resetCostFeed,
  type CostFeedEntry,
} from "./cost-feed.js";

function entry(over: Partial<CostFeedEntry> = {}): CostFeedEntry {
  return {
    ts: 1,
    service: "discutere",
    sessionId: "s1",
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    ...over,
  };
}

const tmp = mkdtempSync(join(tmpdir(), "cc-costfeed-"));

afterEach(() => {
  _resetCostFeed();
  delete process.env.CONCORDIA_COST_FEED_LOG;
});

describe("createJsonlCostFeed", () => {
  it("creates the parent dir and round-trips record→flush→read", async () => {
    const path = join(tmp, "nested", "cost-feed.jsonl");
    const feed = createJsonlCostFeed(path);
    feed.record(entry({ sessionId: "a" }));
    feed.record(entry({ sessionId: "b" }));
    await feed.flush();
    expect(existsSync(path)).toBe(true);
    const rows = await readCostEntries(path);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["a", "b"]);
  });
});

describe("getCostFeed resolution", () => {
  it("persists to the CONCORDIA_COST_FEED_LOG path when set", async () => {
    const path = join(tmp, "env", "feed.jsonl");
    process.env.CONCORDIA_COST_FEED_LOG = path;
    _resetCostFeed();
    const feed = getCostFeed();
    feed.record(entry({ sessionId: "persisted" }));
    await feed.flush();
    const rows = await readCostEntries(path);
    expect(rows.map((r) => r.sessionId)).toContain("persisted");
  });

  it("uses in-memory when CONCORDIA_COST_FEED_LOG is explicitly empty", async () => {
    process.env.CONCORDIA_COST_FEED_LOG = "";
    _resetCostFeed();
    const feed = getCostFeed();
    feed.record(entry({ sessionId: "mem" }));
    await feed.flush();
    // メモリ feed は同一プロセス内では読み戻せる (ファイルには書かれない)。
    const rows = await feed.read();
    expect(rows.map((r) => r.sessionId)).toEqual(["mem"]);
  });
});

// 後始末: 一時ディレクトリを掃除する (env reset は上の afterEach が担当)。
process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
