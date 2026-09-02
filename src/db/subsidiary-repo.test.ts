import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { SubsidiaryRepo } from "./subsidiary-repo.js";

describe("SubsidiaryRepo 関係プロジェクト", () => {
  const setup = () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    return { db, repo: new SubsidiaryRepo(db) };
  };

  it("未設定は空、 設定は丸ごと置換される", () => {
    const { db, repo } = setup();
    const sub = repo.create({ name: "ditest", display_name: "DiTest" });

    expect(repo.listProjects(sub.id)).toEqual([]);
    expect(repo.setProjects(sub.id, ["Pagus", "Ludus"])).toEqual(["Ludus", "Pagus"]);
    expect(repo.setProjects(sub.id, ["Ludus"])).toEqual(["Ludus"]);
    // 空配列は「未設定へ戻す」 (掲載ゼロ)。
    expect(repo.setProjects(sub.id, [])).toEqual([]);
    db.close();
  });

  it("空白と重複を落として保存する", () => {
    const { db, repo } = setup();
    const sub = repo.create({ name: "ditest2", display_name: "DiTest2" });
    expect(repo.setProjects(sub.id, [" Pagus ", "Pagus", "", "  "])).toEqual(["Pagus"]);
    db.close();
  });

  it("子会社を消すと関係プロジェクトも消える", () => {
    const { db, repo } = setup();
    const sub = repo.create({ name: "ditest3", display_name: "DiTest3" });
    repo.setProjects(sub.id, ["Pagus"]);
    expect(repo.delete(sub.id)).toBe(true);
    expect(repo.listProjects(sub.id)).toEqual([]);
    db.close();
  });

  it("子会社ごとに独立している", () => {
    const { db, repo } = setup();
    const a = repo.create({ name: "sub-a", display_name: "A" });
    const b = repo.create({ name: "sub-b", display_name: "B" });
    repo.setProjects(a.id, ["Pagus"]);
    repo.setProjects(b.id, ["Ludus"]);
    expect(repo.listProjects(a.id)).toEqual(["Pagus"]);
    expect(repo.listProjects(b.id)).toEqual(["Ludus"]);
    db.close();
  });

  it("project 名の変更時に所属を引き継ぎ、旧名を残さない", () => {
    const { db, repo } = setup();
    const sub = repo.create({ name: "sub-move", display_name: "Move" });
    const second = repo.create({ name: "sub-move-2", display_name: "Move 2" });
    repo.assignProjectToSubsidiaries("OldProject", [sub.id, second.id]);

    repo.moveProjectAssignment("oldproject", "NewProject");

    expect(repo.listProjects(sub.id)).toEqual(["NewProject"]);
    expect(repo.listProjects(second.id)).toEqual(["NewProject"]);
    expect(repo.listProjectAssignments()).toEqual(expect.arrayContaining([
      { subsidiary_id: sub.id, project: "NewProject" },
      { subsidiary_id: second.id, project: "NewProject" },
    ]));
    expect(repo.listProjectAssignments()).toHaveLength(2);
    db.close();
  });
});
