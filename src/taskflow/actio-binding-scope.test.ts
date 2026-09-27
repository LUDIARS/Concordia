/** @implements spec/feature/task-workflow-v3.md CC-AT-SCOPE-01 */
import { describe, expect, it } from "vitest";
import { matchesActioBindingScope } from "./actio-binding-scope.js";

const target = { project: "Terpsichore", repoPath: "E:/Document/Ars/Terpsichore" };

describe("Actio binding selection", () => {
  it("matches the project name without broadening to prefixes or project codes", () => {
    expect(matchesActioBindingScope(target, { project: "TERPSICHORE" })).toBe(true);
    expect(matchesActioBindingScope(target, { project: "Terpsichore-other" })).toBe(false);
    expect(matchesActioBindingScope(target, { project: "Tp" })).toBe(false);
  });

  it("normalizes Windows repository spelling without matching another checkout", () => {
    expect(matchesActioBindingScope(target, { repoPath: "e:\\document\\ars\\terpsichore\\" })).toBe(true);
    expect(matchesActioBindingScope(target, { repoPath: "E:/Document/Ars/Terpsichore-copy" })).toBe(false);
    expect(matchesActioBindingScope(target)).toBe(true);
  });
});
