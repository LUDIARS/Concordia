import { describe, it, expect } from "vitest";
import {
  filterByProjectScope,
  isProjectInScope,
  isProjectNameInScope,
  projectOfRepoOrigin,
} from "./project-scope.js";

describe("projectOfRepoOrigin", () => {
  it("origin の形が違っても repo 名へ寄せる", () => {
    expect(projectOfRepoOrigin("https://github.com/LUDIARS/Concordia.git")).toBe("Concordia");
    expect(projectOfRepoOrigin("LUDIARS/Concordia")).toBe("Concordia");
    expect(projectOfRepoOrigin("https://github.com/LUDIARS/Concordia/")).toBe("Concordia");
  });
});

describe("isProjectInScope", () => {
  it("関係 project に入る PR だけ通す", () => {
    expect(isProjectInScope("LUDIARS/Pagus", ["Pagus", "Ludus"])).toBe(true);
    expect(isProjectInScope("LUDIARS/Concordia", ["Pagus", "Ludus"])).toBe(false);
  });

  it("大文字小文字と .git の差を吸収する", () => {
    expect(isProjectInScope("https://github.com/LUDIARS/Pagus.git", ["pagus"])).toBe(true);
  });

  it("未設定 (空集合) は 1 件も出さない", () => {
    // 未設定を全許可にすると、 設定漏れがそのまま本社全 PR の漏洩になる。
    expect(isProjectInScope("LUDIARS/Pagus", [])).toBe(false);
  });
});

describe("isProjectNameInScope", () => {
  it("project 名を trim + case-insensitive で照合する", () => {
    expect(isProjectNameInScope("  PICTOR ", ["pictor"])).toBe(true);
  });

  it("project 未解決・空集合は fail-closed", () => {
    expect(isProjectNameInScope(null, ["Pictor"])).toBe(false);
    expect(isProjectNameInScope("", ["Pictor"])).toBe(false);
    expect(isProjectNameInScope("Pictor", [])).toBe(false);
  });
});

describe("filterByProjectScope", () => {
  it("関係 project の候補だけ残す", () => {
    const items = [
      { repoOrigin: "LUDIARS/Pagus", prNumber: 1 },
      { repoOrigin: "LUDIARS/Concordia", prNumber: 2 },
      { repoOrigin: "https://github.com/LUDIARS/Ludus.git", prNumber: 3 },
    ];
    expect(filterByProjectScope(items, ["Pagus", "Ludus"]).map((i) => i.prNumber)).toEqual([1, 3]);
    expect(filterByProjectScope(items, [])).toEqual([]);
  });
});
