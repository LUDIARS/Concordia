/** @implements spec/feature/project-code-registry.md — 大文字小文字の衝突 (CC-PCR-CASE-01) */

import { describe, expect, it } from "vitest";
import { caseCollisionWarnings } from "./project-code-case.js";

describe("caseCollisionWarnings", () => {
  it("warns about codes that differ only by case without blocking", () => {
    expect(caseCollisionWarnings("LD", ["LD", "Ld", "Lp"])).toEqual([{ kind: "case_collision", code: "LD", conflicts_with: ["Ld"] }]);
  });

  it("returns nothing for a unique code", () => {
    expect(caseCollisionWarnings("Cc", ["Cc", "Cr"])).toEqual([]);
  });
});
