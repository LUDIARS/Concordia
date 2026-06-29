import { describe, it, expect, vi } from "vitest";
import { collectOrgCost, renderOrgCostLines, fmtTokens } from "./org-cost.js";
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

function sess(id: string, subsidiaryId: string | null, tokens: number): SessionRow {
  const meta: Record<string, unknown> = { _tokens: tokens };
  if (subsidiaryId) meta.subsidiary_id = subsidiaryId;
  return { id, metadata: JSON.stringify(meta) } as SessionRow;
}

function fakeRepo(rows: SessionRow[]): SessionsRepo {
  return { listSessionsInRange: () => rows } as unknown as SessionsRepo;
}

const NOW = new Date(2026, 5, 29, 12, 0, 0).getTime();

describe("collectOrgCost", () => {
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
    const repo = fakeRepo([{ id: "x", metadata: null } as SessionRow, sess("y", null, 0), sess("z", null, 42)]);
    const r = collectOrgCost(repo, [], NOW);
    expect(r.headOffice.tokens).toBe(42);
  });

  it("子会社一覧の順序を保持し、 該当セッション無しは 0", () => {
    const repo = fakeRepo([sess("a", "sub-2", 10)]);
    const r = collectOrgCost(repo, [
      { id: "sub-1", name: "A", daily_token_budget: 0 },
      { id: "sub-2", name: "B", daily_token_budget: 0 },
    ], NOW);
    expect(r.subsidiaries.map((s) => s.id)).toEqual(["sub-1", "sub-2"]);
    expect(r.subsidiaries[0].tokens).toBe(0);
    expect(r.subsidiaries[1].tokens).toBe(10);
  });
});

describe("renderOrgCostLines", () => {
  it("本社 → 子会社 → 合計 の行を出す (予算 / ∞ / ⚠️)", () => {
    const repo = fakeRepo([sess("a", null, 1234567), sess("b", "sub-1", 1200), sess("c", "sub-2", 5)]);
    const lines = renderOrgCostLines(collectOrgCost(repo, [
      { id: "sub-1", name: "支社A", daily_token_budget: 1000 },
      { id: "sub-2", name: "支社B", daily_token_budget: 0 },
    ], NOW));
    const text = lines.join("\n");
    expect(text).toContain("🏠 本社: 1,234,567");
    expect(text).toContain("支社A: 1,200 / 1,000 ⚠️予算超過");
    expect(text).toContain("支社B: 5 / ∞");
    expect(text).toContain("合計:");
  });
});

describe("fmtTokens", () => {
  it("3桁区切り / 負は0", () => {
    expect(fmtTokens(1234567)).toBe("1,234,567");
    expect(fmtTokens(-5)).toBe("0");
  });
});
