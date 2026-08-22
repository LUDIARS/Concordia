import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { ProjectCodeConflictError, ProjectCodesRepo } from "./project-codes-repo.js";

describe("ProjectCodesRepo", () => {
  it("starts empty and registers the same mapping idempotently", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new ProjectCodesRepo(db);
    expect(repo.list()).toEqual([]);
    const input = {
      code: "MN",
      project: "MakaiNui",
      repoPath: "E:/Document/Ars/MakaiNui",
      repoOrigin: "https://github.com/MELPOT/MakaiNui.git",
      addedBy: "test",
    };
    expect(repo.register(input).created).toBe(true);
    expect(repo.register(input).created).toBe(false);
    db.close();
  });

  it("keeps codes case-sensitive and rejects project reuse", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new ProjectCodesRepo(db);
    repo.register({
      code: "MN",
      project: "MakaiNui",
      repoPath: "E:/Document/Ars/MakaiNui",
      repoOrigin: "https://github.com/MELPOT/MakaiNui.git",
      addedBy: "test",
    });
    expect(repo.findByCode("mn")).toBeNull();
    expect(() => repo.register({
      code: "Other",
      project: "makainui",
      repoPath: "E:/other",
      repoOrigin: "https://example.test/other.git",
      addedBy: "test",
    })).toThrow(ProjectCodeConflictError);
    db.close();
  });

  it("claims a repository once even when the separators differ", () => {
    // repo_path の UNIQUE は COLLATE NOCASE で、 区切りの違いまでは畳んでくれない。
    // 正規化せずに保存していた頃は、 同じ repository を `\` 表記で登録し直すと
    // assertUnclaimed を素通りして 2 つ目の code が生えた。
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new ProjectCodesRepo(db);
    repo.register({
      code: "MN",
      project: "MakaiNui",
      repoPath: "E:/Document/Ars/MakaiNui",
      repoOrigin: null,
      addedBy: "test",
    });
    expect(() => repo.register({
      code: "MN2",
      project: "MakaiNuiAlias",
      repoPath: "E:\\Document\\Ars\\MakaiNui\\",
      repoOrigin: null,
      addedBy: "test",
    })).toThrow(ProjectCodeConflictError);
    db.close();
  });

  it("stores the real path casing so it stays usable as a spawn cwd", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new ProjectCodesRepo(db);
    const { row } = repo.register({
      code: "MN",
      project: "MakaiNui",
      repoPath: "E:\\Document\\Ars\\MakaiNui",
      repoOrigin: null,
      addedBy: "test",
    });
    expect(row.repo_path).toBe("E:/Document/Ars/MakaiNui");
    db.close();
  });
});
