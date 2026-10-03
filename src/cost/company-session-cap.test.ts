/** @implements spec/feature/usage-budgets.md §9 — 会社ごとの同時セッション上限の判定 */
import { describe, expect, it } from "vitest";
import {
  buildCompanySessionCapRow,
  countActiveSessionsByCompany,
  decideCompanySessionCap,
  normalizeSessionCap,
  sessionCapRefusalText,
  SESSION_CAP_ERROR_PREFIX,
} from "./company-session-cap.js";

const meta = (subsidiaryId?: string): { metadata: string | null } =>
  ({ metadata: subsidiaryId === undefined ? null : JSON.stringify({ subsidiary_id: subsidiaryId }) });

describe("countActiveSessionsByCompany", () => {
  it("counts untagged sessions (and broken metadata) as the head office and tagged ones per subsidiary", () => {
    const counts = countActiveSessionsByCompany([
      meta(), meta(), { metadata: "{broken" }, meta("sub-a"), meta("sub-a"), meta("sub-b"),
    ]);
    expect(counts.get(null)).toBe(3);
    expect(counts.get("sub-a")).toBe(2);
    expect(counts.get("sub-b")).toBe(1);
  });
});

describe("decideCompanySessionCap", () => {
  it("refuses once the running sessions reach the cap, naming the company and the cap", () => {
    const decision = decideCompanySessionCap(buildCompanySessionCapRow({ subsidiaryId: null, name: "本社", active: 30, max: 30 }));
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toContain("本社のセッション上限 (30) に達しています");
  });

  it("allows while below the cap", () => {
    expect(decideCompanySessionCap(buildCompanySessionCapRow({ subsidiaryId: null, name: "本社", active: 29, max: 30 })))
      .toEqual({ allowed: true });
  });

  it("never refuses a company without a cap (0)", () => {
    expect(decideCompanySessionCap(buildCompanySessionCapRow({ subsidiaryId: "sub", name: "出張所", active: 500, max: 0 })))
      .toEqual({ allowed: true });
  });
});

describe("normalizeSessionCap", () => {
  it("treats non-numbers and negatives as no cap and floors fractions", () => {
    expect(normalizeSessionCap("x")).toBe(0);
    expect(normalizeSessionCap(-3)).toBe(0);
    expect(normalizeSessionCap(12.7)).toBe(12);
  });
});

describe("sessionCapRefusalText", () => {
  it("recovers the human-facing text only from a session-cap error", () => {
    expect(sessionCapRefusalText(`HTTP 429: ${SESSION_CAP_ERROR_PREFIX}本社のセッション上限 (30) に達しています。`))
      .toBe("本社のセッション上限 (30) に達しています。");
    expect(sessionCapRefusalText("budget_exhausted: 予算切れ")).toBeNull();
  });
});
