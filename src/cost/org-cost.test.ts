import { describe, it, expect, vi } from "vitest";
import {
  collectOrgCost,
  collectOrgCostWeekly,
  renderOrgCostLines,
  localWeekRange,
  fmtTokens,
} from "./org-cost.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";

// readSessionUsage はログファイルを読むので、 org-cost.test では vi.mock で差し替える。
vi.mock("./log-usage.js", () => ({
  // metadata に usage を埋め込んでおき、 それを返すフェイク (テスト専用の橋渡し)。
  readSessionUsage: (s: SessionRow) => {
    try {
      const o = JSON.parse(s.metadata ?? "{}") as { _tokens?: number };
      return o._tokens ? { input: 0, cached: 0, output: 0, total: o._tokens } : null;
    } catch {
      return null;
    }
  },
}));

const NOW = new Date(2026, 5, 29, 12, 0, 0).getTime();

function sess(id: string, subsidiaryId: string | null, tokens: number, startedAt = NOW): SessionRow {
  const meta: Record<string, unknown> = { _tokens: tokens };
  if (subsidiaryId) meta.subsidiary_id = subsidiaryId;
  return { id, metadata: JSON.stringify(meta), started_at: startedAt } as unknown as SessionRow;
}

/** listSessionsInRange を started_at で [start,end) 絞り込みする range-aware フェイク。 */
function fakeRepo(rows: SessionRow[]): SessionsRepo {
  return {
    listSessionsInRange: (start: number, end: number) =>
      rows.filter((r) => {
        const at = (r as unknown as { started_at: number }).started_at;
        return at >= start && at < end;
      }),
  } as unknown as SessionsRepo;
}

describe("collectOrgCost (本日)", () => {
  it("本社 (未タグ) と子会社をトークン別に集計する", () => {
    const repo = fakeRepo([
      sess("a", null, 1000),
      sess("b", null, 500),
      sess("c", "sub-1", 300),
      sess("d", "sub-1", 200),
      sess("e", "sub-2", 50),
    ]);
    const r = collectOrgCost(repo, [
      { id: "sub-1", name: "支社A", daily_token_budget: 1000 },
      { id: "sub-2", name: "支社B", daily_token_budget: 0 },
    ], NOW);

    expect(r.headOffice.tokens).toBe(1500);
    expect(r.subsidiaries.find((s) => s.id === "sub-1")?.tokens).toBe(500);
    expect(r.subsidiaries.find((s) => s.id === "sub-2")?.tokens).toBe(50);
    expect(r.totalTokens).toBe(2050);
  });

  it("予算超過は blocked、 budget=0 は無制限 (blocked=false)", () => {
    const repo = fakeRepo([sess("a", "sub-1", 1200), sess("b", "sub-2", 999999)]);
    const r = collectOrgCost(repo, [
      { id: "sub-1", name: "A", daily_token_budget: 1000 },
      { id: "sub-2", name: "B", daily_token_budget: 0 },
    ], NOW);
    expect(r.subsidiaries.find((s) => s.id === "sub-1")?.blocked).toBe(true);
    expect(r.subsidiaries.find((s) => s.id === "sub-2")?.blocked).toBe(false);
  });

  it("未知の subsidiary_id (削除済み) は本社に混ぜず total のみ反映", () => {
    const repo = fakeRepo([sess("a", null, 100), sess("b", "gone", 70)]);
    const r = collectOrgCost(repo, [], NOW);
    expect(r.headOffice.tokens).toBe(100);
    expect(r.totalTokens).toBe(170);
    expect(r.subsidiaries).toHaveLength(0);
  });

  it("usage が無い / 0 のセッションは無視", () => {
    const repo = fakeRepo([
      { id: "x", metadata: null, started_at: NOW } as unknown as SessionRow,
      sess("y", null, 0),
      sess("z", null, 42),
    ]);
    const r = collectOrgCost(repo, [], NOW);
    expect(r.headOffice.tokens).toBe(42);
  });
});

describe("collectOrgCostWeekly (週間)", () => {
  it("直近7暦日のセッションを集計し、 範囲外 (8日前) は除外", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const repo = fakeRepo([
      sess("today", null, 100, NOW),
      sess("d6", "sub-1", 200, NOW - 6 * dayMs + 1000), // 6日前 = 範囲内
      sess("d8", null, 999, NOW - 8 * dayMs),           // 8日前 = 範囲外
    ]);
    const subs = [{ id: "sub-1", name: "A", daily_token_budget: 1000 }];

    const weekly = collectOrgCostWeekly(repo, subs, NOW);
    expect(weekly.headOffice.tokens).toBe(100);            // d8 は除外
    expect(weekly.subsidiaries[0].tokens).toBe(200);
    expect(weekly.totalTokens).toBe(300);

    // 本日集計だと 6日前のセッションは入らない。
    const daily = collectOrgCost(repo, subs, NOW);
    expect(daily.subsidiaries[0].tokens).toBe(0);
    expect(daily.headOffice.tokens).toBe(100);
  });

  it("週間は予算概念を持たない (budget=0 / blocked=false)", () => {
    const repo = fakeRepo([sess("a", "sub-1", 5000)]);
    const weekly = collectOrgCostWeekly(repo, [{ id: "sub-1", name: "A", daily_token_budget: 1000 }], NOW);
    expect(weekly.subsidiaries[0].budget).toBe(0);
    expect(weekly.subsidiaries[0].blocked).toBe(false);
  });
});

describe("localWeekRange", () => {
  it("今日含む直近7暦日 [00:00(6日前), 翌00:00)", () => {
    const [start, end] = localWeekRange(NOW);
    expect(start).toBe(new Date(2026, 5, 23, 0, 0, 0).getTime());
    expect(end).toBe(new Date(2026, 5, 30, 0, 0, 0).getTime());
  });
});

describe("renderOrgCostLines", () => {
  it("daily のみ: 本日ブロック (予算 / 超過、 budget=0 は予算表記なし)", () => {
    const repo = fakeRepo([sess("a", null, 1234567), sess("b", "sub-1", 1200), sess("c", "sub-2", 5)]);
    const lines = renderOrgCostLines(collectOrgCost(repo, [
      { id: "sub-1", name: "支社A", daily_token_budget: 1000 },
      { id: "sub-2", name: "支社B", daily_token_budget: 0 },
    ], NOW));
    const text = lines.join("\n");
    expect(text).toContain("### コスト (トークン)");
    expect(text).toContain("**本日 (2026-06-29)**");
    expect(text).toContain("🏠 本社: 1,234,567");
    expect(text).toContain("支社A: 1,200 / 1,000 ⚠️予算超過");
    expect(text).toContain("支社B: 5"); // budget=0 は "/ ∞" を出さない
    expect(text).not.toContain("週間");
  });

  it("daily + weekly: 本日 / 週間 の 2 ブロックを出す", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const repo = fakeRepo([sess("a", null, 100, NOW), sess("b", null, 50, NOW - 3 * dayMs)]);
    const subs = [{ id: "sub-1", name: "支社A", daily_token_budget: 0 }];
    const lines = renderOrgCostLines(collectOrgCost(repo, subs, NOW), collectOrgCostWeekly(repo, subs, NOW));
    const text = lines.join("\n");
    expect(text).toContain("**本日 (2026-06-29)**");
    expect(text).toContain("**週間 (2026-06-23〜2026-06-29)**");
    // 本日合計=100、 週間合計=150。
    const todayIdx = text.indexOf("本日");
    const weekIdx = text.indexOf("週間");
    expect(text.slice(todayIdx, weekIdx)).toContain("合計: 100");
    expect(text.slice(weekIdx)).toContain("合計: 150");
  });
});

describe("fmtTokens", () => {
  it("3桁区切り / 負は0", () => {
    expect(fmtTokens(1234567)).toBe("1,234,567");
    expect(fmtTokens(-5)).toBe("0");
  });
});
