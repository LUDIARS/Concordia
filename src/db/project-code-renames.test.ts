/** @implements spec/feature/project-code-registry.md — 改名の追跡 (CC-PCR-RENAME-01) */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { renamedFromByCode } from "./project-code-renames.js";
import { ProjectCodesRepo } from "./project-codes-repo.js";

describe("renamedFromByCode", () => {
  it("follows a rename chain newest first", () => {
    expect(renamedFromByCode([
      { from_code: "A", to_code: "B", renamed_at: 1 },
      { from_code: "B", to_code: "C", renamed_at: 2 },
    ], new Set(["C"]))).toEqual(new Map([["C", ["B", "A"]]]));
  });

  it("does not report a code that is registered again for another project", () => {
    expect(renamedFromByCode([{ from_code: "LwP", to_code: "LP", renamed_at: 1 }], new Set(["LP", "LwP"])))
      .toEqual(new Map());
  });

  it("stops on a cycle instead of looping", () => {
    expect(renamedFromByCode([
      { from_code: "A", to_code: "B", renamed_at: 1 },
      { from_code: "B", to_code: "A", renamed_at: 2 },
    ], new Set(["A"]))).toEqual(new Map([["A", ["B"]]]));
  });
});

describe("ProjectCodesRepo rename history", () => {
  it("records a code change in the same update and exposes it as renamed_from", () => {
    const repo = new ProjectCodesRepo(makeTestDb());
    repo.register({ code: "LwP", project: "Ludellus-Praeforma", repoPath: "C:/repos/LP", repoOrigin: null, addedBy: "test" });
    repo.update("LwP", { domainReview: true });
    expect(repo.renamedFrom()).toEqual(new Map());
    repo.update("LwP", { code: "LP" });
    expect(repo.renamedFrom()).toEqual(new Map([["LP", ["LwP"]]]));
  });
});
