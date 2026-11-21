import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { AGY_USAGE_BINDINGS } from "./agy-usage-binding.js";
import { agyUsagePoints, readAgySessionGenerations } from "./agy-session-usage.js";
import * as agySessionUsage from "./agy-session-usage.js";
import { estimateAgyCost } from "./agy-session-cost.js";
import { readRecentAgyBudgetUsage } from "./agy-recent-usage.js";
import { decodeAgyGeneration } from "./agy-usage-metadata.js";
import { accumulateAgyUsageWindows, totalAgyUsage } from "./agy-usage-policy.js";
import { CostBudgetRepo } from "./cost-budget-repo.js";
import { makeCachedChannelCostReader } from "./channel-cost-cache.js";
import { readSessionContextObservation } from "./context-observation-reader.js";
import { collectProviderWeeklyTokens } from "./provider-weekly-tokens.js";
import { estimateSessionCostUsd } from "./session-cost.js";
import { cachedReadSessionUsage } from "./session-usage-cache.js";
import { localDateIso, CostUsageTracker } from "./usage-tracker.js";
import { readSessionUsageTimeline } from "./usage-timeline.js";
import { makeCachedSessionWindowReader } from "./windowed-usage-cache.js";

const id = "11111111-1111-4111-8111-111111111111";
const start = 1_795_216_650;

function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  return Buffer.from([...bytes, value]);
}

function integer(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function message(field: number, ...bytes: Buffer[]): Buffer {
  const data = Buffer.concat(bytes);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}

function generation(step: number, time?: number, model = "gemini-4-neon"): Buffer {
  const usage = message(4, integer(1, 1532), integer(2, 2278), integer(3, 628), integer(4, 40),
    integer(5, 24039), integer(9, 522), integer(10, 106));
  const timing = time === undefined ? Buffer.alloc(0) : message(9, message(4, integer(1, time)));
  return Buffer.concat([
    message(1, usage, timing, message(17, message(2, usage)), message(19, Buffer.from(model))),
    message(2, varint(step)),
  ]);
}

describe("Gemini usage from a synthetic agy SQLite conversation", () => {
  let root: string;
  let writer: Database.Database;
  let session: SessionRow;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-test-agy-"));
    writer = new Database(join(root, id + ".db"));
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec(`
      CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
      CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
    `);
    const step = writer.prepare("INSERT INTO steps VALUES (?, ?, 3, ?)");
    step.run(1, 14, null);
    step.run(2, 15, message(1, integer(1, start)));
    step.run(3, 14, null);
    session = {
      id: "agy-fixture", provider: "antigravity-cli", repo_path: root, repo_origin: null,
      branch: null, host: "fixture", started_at: start, last_seen_at: start + 10,
      transcript_path: null, status: "ended", ended_at: start + 10,
      metadata: JSON.stringify({ [AGY_USAGE_BINDINGS]: [{ id, startedAtMs: start * 1000 }] }),
    } as SessionRow;
  });

  afterEach(async () => {
    writer.close();
    await rm(root, { recursive: true, force: true });
  });

  function insert(index: number, data: Buffer): void {
    writer.prepare("INSERT INTO gen_metadata VALUES (?, ?, ?)").run(index, data, data.length);
  }

  it("uses the documented metadata fields and counts thinking once", () => {
    expect(decodeAgyGeneration(generation(2, start))).toEqual({
      atMs: start * 1000, stepIndex: 2, turnIndex: null, model: "gemini-4-neon",
      input: 2278, cached: 24039, output: 628, thinking: 522, total: 26945,
    });
    expect(decodeAgyGeneration(Buffer.from([0x0a, 255]))).toBeNull();
  });

  it("sees WAL-only commits, invalidates the cache, and attributes disjoint session and budget windows", async () => {
    insert(0, generation(0, start - 2));
    insert(1, generation(2));
    expect(totalAgyUsage(await readAgySessionGenerations(session, root))?.total).toBe(26945);
    insert(2, generation(4, start + 5, "gemini-unknown"));
    insert(3, generation(5, start + 10));
    insert(4, generation(6));
    const rows = await readAgySessionGenerations(session, root);
    expect(agyUsagePoints(rows)).toEqual([
      { atMs: start * 1000, tokens: 26945, turnEnd: true },
      { atMs: (start + 5) * 1000, tokens: 26945 },
    ]);
    expect(accumulateAgyUsageWindows(rows, [
      { key: "before", startSec: start - 5, endSec: start },
      { key: "first", startSec: start, endSec: start + 5 },
      { key: "second", startSec: start + 5, endSec: start + 10 },
    ])).toEqual({ before: 0, first: 26945, second: 26945 });
    expect(estimateAgyCost(rows)).toMatchObject({ pricedTokens: 26945, unpricedTokens: 26945 });
    expect(estimateAgyCost(rows)?.usd).toBeCloseTo(0.01985985, 10);
    expect(await readAgySessionGenerations({ ...session, metadata: null }, root)).toEqual([]);
  });

  it("exposes the same measured tokens to the cost views and weekly provider aggregate", async () => {
    insert(0, generation(2, start));
    const read = readAgySessionGenerations;
    const fixture = vi.spyOn(agySessionUsage, "readAgySessionGenerations").mockImplementation((s) => read(s, root));
    try {
      const channel = makeCachedChannelCostReader();
      const windows = [{ key: "daily", startSec: start, endSec: start + 1 }];
      expect(await channel.cost(session)).toBe(26945);
      expect(await channel.context(session)).toBe(26317);
      expect(await readSessionContextObservation(session)).toEqual({ tokens: 26317, windowTokens: null });
      expect((await cachedReadSessionUsage(session))?.total).toBe(26945);
      expect((await estimateSessionCostUsd(session))?.pricedTokens).toBe(26945);
      expect(await readSessionUsageTimeline(session)).toEqual([{ atMs: start * 1000, tokens: 26945 }]);
      expect(await makeCachedSessionWindowReader()(session, windows)).toEqual({ daily: 26945 });
      const weekly = await collectProviderWeeklyTokens({ listSessionsSeenSince: () => [session] }, (start + 5) * 1000);
      expect(weekly.tokens).toEqual(new Map([["antigravity-cli", 26945]]));
    } finally {
      fixture.mockRestore();
    }
  });

  it("advances the global daily budget cursor once and ignores unreadable databases", { timeout: 15_000 }, async () => {
    await writeFile(join(root, "22222222-2222-4222-8222-222222222222.db"), "not sqlite");
    const ledger = new Database(":memory:");
    try {
      ledger.exec(`
        CREATE TABLE cost_daily_usage(date_iso TEXT PRIMARY KEY, tokens INTEGER, updated_at INTEGER);
        CREATE TABLE cost_log_seen(log_path TEXT PRIMARY KEY, last_total INTEGER, updated_at INTEGER);
      `);
      const repo = new CostBudgetRepo(ledger);
      const now = Date.now();
      const date = localDateIso(now);
      const tracker = new CostUsageTracker({
        repo, now: () => now, getBudget: () => 26945,
        enumerate: async () => [],
        enumerateAgy: (age, time) => readRecentAgyBudgetUsage(age, time, root),
      });
      insert(0, generation(2, start));
      await tracker.sample();
      expect(repo.getDayTokens(date)).toBe(0);
      insert(1, generation(2, start + 1));
      await tracker.sample();
      await tracker.sample();
      expect(repo.getDayTokens(date)).toBe(26945);
      expect(tracker.status()).toMatchObject({ todayTokens: 26945, blocked: true });
    } finally {
      ledger.close();
    }
  });
});
