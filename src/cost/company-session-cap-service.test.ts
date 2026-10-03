/** @implements spec/feature/usage-budgets.md §9 — 会社ごとの稼働数と上限の集計・起動判定 */
import { describe, expect, it } from "vitest";
import { createCompanySessionCaps } from "./company-session-cap-service.js";

function caps(input: {
  active: Array<string | null>;
  headOfficeMax: number;
  subsidiaries: Array<{ id: string; name: string; max_sessions: number }>;
}) {
  return createCompanySessionCaps({
    sessions: {
      findAllActive: () => input.active.map((sub) => ({ metadata: sub ? JSON.stringify({ subsidiary_id: sub }) : null })),
    } as never,
    headOfficeMax: () => input.headOfficeMax,
    subsidiaries: {
      list: () => input.subsidiaries.map((sub) => ({ ...sub, display_name: "" })),
    } as never,
  });
}

describe("CompanySessionCaps", () => {
  it("reports the head office first, then each subsidiary, with running counts and caps", () => {
    const report = caps({
      active: [null, null, "s1"],
      headOfficeMax: 2,
      subsidiaries: [{ id: "s1", name: "alpha", max_sessions: 0 }, { id: "s2", name: "beta", max_sessions: 5 }],
    }).report();
    expect(report).toEqual([
      { subsidiary_id: null, name: "本社", active: 2, max: 2, reached: true },
      { subsidiary_id: "s1", name: "alpha", active: 1, max: 0, reached: false },
      { subsidiary_id: "s2", name: "beta", active: 0, max: 5, reached: false },
    ]);
  });

  it("refuses a launch only for the company that is at its cap", () => {
    const service = caps({
      active: ["s2", "s2", null],
      headOfficeMax: 30,
      subsidiaries: [{ id: "s2", name: "beta", max_sessions: 2 }],
    });
    expect(service.check(null)).toEqual({ allowed: true });
    const refused = service.check("s2");
    expect(refused.allowed).toBe(false);
    expect(!refused.allowed && refused.reason).toContain("betaのセッション上限 (2)");
  });

  it("does not block a subsidiary id that is not registered", () => {
    expect(caps({ active: ["ghost"], headOfficeMax: 30, subsidiaries: [] }).check("ghost")).toEqual({ allowed: true });
  });
});
