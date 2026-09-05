import { describe, expect, it } from "vitest";
import { seedDomainReview } from "./domain-review-seed.js";

describe("domain_review の初期値 (設計書 §8.3)", () => {
  it("LUDIARS のプロダクトは ON", () => {
    expect(seedDomainReview({
      project: "Concordia",
      repoOrigin: "https://github.com/LUDIARS/Concordia.git",
    })).toBe(true);
    expect(seedDomainReview({
      project: "AdventureCube",
      repoOrigin: "git@github.com:LUDIARS/AdventureCube.git",
    })).toBe(true);
  });

  it("MELPOT の MakaiNui / MakaiNuiPictor も ON", () => {
    expect(seedDomainReview({
      project: "MakaiNui",
      repoOrigin: "https://github.com/MELPOT/MakaiNui.git",
    })).toBe(true);
    expect(seedDomainReview({
      project: "MakaiNuiPictor",
      repoOrigin: "MELPOT/MakaiNuiPictor",
    })).toBe(true);
  });

  it("Castra (ワークスペース root) とメタ / インフラ枠は OFF", () => {
    for (const project of ["Ars", "Castra", "LUDIARS", "infra", "AIFormat", "All-In-OneTest"]) {
      expect(seedDomainReview({
        project,
        repoOrigin: `https://github.com/LUDIARS/${project}.git`,
      })).toBe(false);
    }
  });

  it("外部 org は OFF", () => {
    expect(seedDomainReview({
      project: "SomeTool",
      repoOrigin: "https://github.com/other-org/SomeTool.git",
    })).toBe(false);
  });

  it("GitHub 以外の host が LUDIARS 名を名乗っても OFF", () => {
    expect(seedDomainReview({
      project: "SomeTool",
      repoOrigin: "https://example.test/LUDIARS/SomeTool.git",
    })).toBe(false);
    expect(seedDomainReview({
      project: "SomeTool",
      repoOrigin: "git@example.test:LUDIARS/SomeTool.git",
    })).toBe(false);
  });

  it("repo_origin が無い登録は owner を確かめられないので OFF", () => {
    expect(seedDomainReview({ project: "Concordia", repoOrigin: null })).toBe(false);
    expect(seedDomainReview({ project: "Concordia", repoOrigin: "   " })).toBe(false);
  });

  it("owner の大小文字は畳む", () => {
    expect(seedDomainReview({
      project: "Ergo",
      repoOrigin: "https://github.com/ludiars/Ergo.git",
    })).toBe(true);
  });
});
