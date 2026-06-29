import { describe, it, expect } from "vitest";
import { collectOrgCostWindows, renderOrgCostLines, fmtTokens } from "./org-cost.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { UsageWindow } from "./windowed-usage.js";

const NOW = new Date(2026, 5, 29, 12, 0, 0).getTime();

function sess(id: string, subsidiaryId: string | null): SessionRow {
  const meta: Record<string, unknown> = {};
  if (subsidiaryId) meta.subsidiary_id = subsidiaryId;
  return { id, metadata: Object.keys(meta).length ? JSON.stringify(meta) : null } as unknown as SessionRow;
}

function fakeRepo(rows: SessionRow[]): SessionsRepo {
  return { listSessionsSeenSince: () => rows } as unknown as SessionsRepo;
}

/** session id -> {d, w} を返す reader を作る (JSONL を読まずテスト)。 */
function reader(map: Record<string, { d: number; w: number }>) {
  return (s: SessionRow, _windows: UsageWindow[]): Record<string, number> => {
    const v = map[s.id] ?? { d: 0, w: 0 };
    return { d: v.d, w: v.w };
  };
}

describe("collectOrgCostWindows", () => {
  it("本社/子会社別に 本日・週間 を時間帯集計する", () => {
    const repo = fakeRepo([sess("a", null), sess("b", "sub-1"), sess("c", "sub-1"), sess("d", "sub-2")]);
    const r = collectOrgCostWindows(repo, [
      { id: "sub-1", name: "支社A", daily_token_budget: 1000 },
      { id: "sub-2", name: "支社B", daily_token_budget: 0 },
    ], NOW, reader({
      a: { d: 100, w: 700 },
      b: { d: 300, w: 1000 },
      c: { d: 200, w: 500 },
      d: { d: 0, w: 50 },
    }));

    expect(r.daily.headOffice.tokens).toBe(100);
    expect(r.daily.subsidiaries.find((s) => s.id === "sub-1")?.tokens).toBe(500);
    expect(r.daily.subsidiaries.find((s) => s.id === "sub-2")?.tokens).toBe(0);
    expect(r.daily.totalTokens).toBe(600);

    expect(r.weekly.headOffice.tokens).toBe(700);
    expect(r.weekly.subsidiaries.find((s) => s.id === "sub-1")?.tokens).toBe(1500);
    expect(r.weekly.subsidiaries.find((s) => s.id === "sub-2")?.tokens).toBe(50);
    expect(r.weekly.totalTokens).toBe(2250);
  });

  it("本日は予算/超過を持つ、 週間は予算概念なし", () => {
    const repo = fakeRepo([sess("a", "sub-1")]);
    const r = collectOrgCostWindows(repo, [{ id: "sub-1", name: "A", daily_token_budget: 1000 }], NOW,
      reader({ a: { d: 1200, w: 5000 } }));
    expect(r.daily.subsidiaries[0].blocked).toBe(true);
    expect(r.daily.subsidiaries[0].budget).toBe(1000);
    expect(r.weekly.subsidiaries[0].blocked).toBe(false);
    expect(r.weekly.subsidiaries[0].budget).toBe(0);
  });

  it("未知の subsidiary_id は本社に混ぜず total のみ反映", () => {
    const repo = fakeRepo([sess("a", null), sess("b", "gone")]);
    const r = collectOrgCostWindows(repo, [], NOW, reader({ a: { d: 100, w: 100 }, b: { d: 70, w: 70 } }));
    expect(r.daily.headOffice.tokens).toBe(100);
    expect(r.daily.totalTokens).toBe(170);
    expect(r.daily.subsidiaries).toHaveLength(0);
  });

  it("ラベル: 本日=当日、 週間=6日前〜当日", () => {
    const repo = fakeRepo([]);
    const r = collectOrgCostWindows(repo, [], NOW, reader({}));
    expect(r.daily.label).toBe("2026-06-29");
    expect(r.weekly.label).toBe("2026-06-23〜2026-06-29");
  });

  it("d/w とも 0 のセッションはスキップ", () => {
    const repo = fakeRepo([sess("a", null), sess("z", null)]);
    const r = collectOrgCostWindows(repo, [], NOW, reader({ a: { d: 0, w: 0 }, z: { d: 5, w: 5 } }));
    expect(r.daily.headOffice.tokens).toBe(5);
  });
});

describe("renderOrgCostLines", () => {
  it("本日 / 週間 の 2 ブロックを出す (予算/超過/予算なし)", () => {
    const repo = fakeRepo([sess("a", null), sess("b", "sub-1"), sess("c", "sub-2")]);
    const r = collectOrgCostWindows(repo, [
      { id: "sub-1", name: "支社A", daily_token_budget: 1000 },
      { id: "sub-2", name: "支社B", daily_token_budget: 0 },
    ], NOW, reader({ a: { d: 1234567, w: 2000000 }, b: { d: 1200, w: 1200 }, c: { d: 5, w: 5 } }));
    const text = renderOrgCostLines(r).join("\n");
    expect(text).toContain("### コスト (トークン)");
    expect(text).toContain("**本日 (2026-06-29)**");
    expect(text).toContain("**週間 (2026-06-23〜2026-06-29)**");
    expect(text).toContain("🏠 本社: 1,234,567");
    expect(text).toContain("支社A: 1,200 / 1,000 ⚠️予算超過");
    expect(text).toContain("支社B: 5");
  });
});

describe("fmtTokens", () => {
  it("3桁区切り / 負は0", () => {
    expect(fmtTokens(1234567)).toBe("1,234,567");
    expect(fmtTokens(-5)).toBe("0");
  });
});
