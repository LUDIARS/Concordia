import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { CostBudgetRepo } from "../src/cost/cost-budget-repo.js";
import { CostUsageTracker, localDateIso } from "../src/cost/usage-tracker.js";

function boot() {
  const db = makeTestDb();
  return { db, repo: new CostBudgetRepo(db) };
}

// 固定時刻 (2026-06-11 09:00 local 相当の epoch を使わず、 任意の固定値)。
const T0 = 1_700_000_000_000;

describe("CostUsageTracker", () => {
  let env: ReturnType<typeof boot>;
  beforeEach(() => { env = boot(); });

  function makeTracker(opts: {
    budget: number;
    now: number;
    files: () => Array<{ path: string; total: number }>;
  }) {
    return new CostUsageTracker({
      repo: env.repo,
      getBudget: () => opts.budget,
      now: () => opts.now,
      enumerate: async () => opts.files(),
    });
  }

  it("初回サンプルは baseline のみ記録し当日には加算しない", async () => {
    let total = 1000;
    const t = makeTracker({ budget: 0, now: T0, files: () => [{ path: "a.jsonl", total }] });
    await t.sample();
    expect(env.repo.getDayTokens(localDateIso(T0))).toBe(0);
    expect(env.repo.getLogLastTotal("a.jsonl")).toBe(1000);
  });

  it("2 回目以降は増分 (delta) を当日に加算する", async () => {
    let total = 1000;
    const t = makeTracker({ budget: 0, now: T0, files: () => [{ path: "a.jsonl", total }] });
    await t.sample();           // baseline 1000
    total = 1700;
    await t.sample();           // +700
    total = 2000;
    await t.sample();           // +300
    expect(env.repo.getDayTokens(localDateIso(T0))).toBe(1000);
  });

  it("予算超過で blocked=true、 未満なら false、 budget=0 は常に false", async () => {
    let total = 0;
    const now = T0;
    const t = makeTracker({ budget: 1000, now, files: () => [{ path: "a.jsonl", total }] });
    await t.sample();           // baseline 0
    total = 600;
    await t.sample();           // +600 (今日 600)
    expect(t.status().todayTokens).toBe(600);
    expect(t.isBlocked()).toBe(false);
    total = 1200;
    await t.sample();           // +600 (今日 1200 >= 1000)
    expect(t.isBlocked()).toBe(true);

    // budget=0 (無効) は超過でも block しない。
    const t0 = makeTracker({ budget: 0, now, files: () => [{ path: "a.jsonl", total }] });
    expect(t0.isBlocked()).toBe(false);
  });

  it("外部バッチ (登録外ログ) の増分も加算される — 複数ファイル合算", async () => {
    const totals: Record<string, number> = { "a.jsonl": 0, "b.jsonl": 0 };
    const t = makeTracker({
      budget: 0,
      now: T0,
      files: () => Object.entries(totals).map(([path, total]) => ({ path, total })),
    });
    await t.sample();                 // baseline 両方 0
    totals["a.jsonl"] = 500;    // 登録セッション
    totals["b.jsonl"] = 800;    // 外部バッチ
    await t.sample();
    expect(env.repo.getDayTokens(localDateIso(T0))).toBe(1300);
  });
});
