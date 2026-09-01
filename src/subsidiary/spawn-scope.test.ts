import { describe, expect, it } from "vitest";
import { checkSubsidiarySpawnTarget, subsidiarySpawnDenialMessage } from "./spawn-scope.js";

describe("子会社 /spawn の対象プロジェクト判定", () => {
  it("関係プロジェクト内なら通す (大小文字は無視)", () => {
    expect(checkSubsidiarySpawnTarget({ project: "concordia", projects: ["Concordia", "Pictor"] }))
      .toEqual({ ok: true, project: "concordia" });
  });

  it("関係プロジェクト未設定は起動させない", () => {
    expect(checkSubsidiarySpawnTarget({ project: "Concordia", projects: [] }))
      .toEqual({ ok: false, denial: "no_projects" });
  });

  it("project 未指定は起動させない (何を起こすか照合できない)", () => {
    expect(checkSubsidiarySpawnTarget({ projects: ["Concordia"] }))
      .toEqual({ ok: false, denial: "project_missing" });
    expect(checkSubsidiarySpawnTarget({ project: "   ", projects: ["Concordia"] }))
      .toEqual({ ok: false, denial: "project_missing" });
  });

  it("cwd の直接指定は project 集合と突き合わせられないので拒否する", () => {
    expect(checkSubsidiarySpawnTarget({
      project: "Concordia",
      cwd: "C:/workspace/Cernere",
      projects: ["Concordia"],
    })).toEqual({ ok: false, denial: "cwd_not_allowed" });
  });

  it("担当外の project は拒否する", () => {
    expect(checkSubsidiarySpawnTarget({ project: "Cernere", projects: ["Concordia"] }))
      .toEqual({ ok: false, denial: "out_of_scope" });
  });

  it("deny 文面に対象 project も許可集合も出さない", () => {
    for (const denial of ["no_projects", "project_missing", "cwd_not_allowed", "out_of_scope"] as const) {
      const message = subsidiarySpawnDenialMessage(denial);
      expect(message).not.toContain("Concordia");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
