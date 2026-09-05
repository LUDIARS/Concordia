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
      project: "BetaGame",
      repoPath: "C:/repos/BetaGame",
      repoOrigin: "https://github.com/PartnerOrg/BetaGame.git",
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
      project: "BetaGame",
      repoPath: "C:/repos/BetaGame",
      repoOrigin: "https://github.com/PartnerOrg/BetaGame.git",
      addedBy: "test",
    });
    expect(repo.findByCode("mn")).toBeNull();
    expect(() => repo.register({
      code: "Other",
      project: "betagame",
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
      project: "BetaGame",
      repoPath: "C:/repos/BetaGame",
      repoOrigin: null,
      addedBy: "test",
    });
    expect(() => repo.register({
      code: "MN2",
      project: "BetaGameAlias",
      repoPath: "C:\\repos\\BetaGame\\",
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
      project: "BetaGame",
      repoPath: "C:\\repos\\BetaGame",
      repoOrigin: null,
      addedBy: "test",
    });
    expect(row.repo_path).toBe("C:/repos/BetaGame");
    db.close();
  });
});

describe("ProjectCodesRepo update/remove", () => {
  function seeded() {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new ProjectCodesRepo(db);
    repo.register({
      code: "MN",
      project: "BetaGame",
      repoPath: "C:/repos/BetaGame",
      repoOrigin: "https://github.com/PartnerOrg/BetaGame.git",
      addedBy: "test",
    });
    repo.register({
      code: "Cc",
      project: "Concordia",
      repoPath: "E:/Document/Ars/Concordia",
      repoOrigin: "https://github.com/LUDIARS/Concordia.git",
      addedBy: "test",
    });
    return { db, repo };
  }

  it("updates fields in place and supports code rename", () => {
    const { db, repo } = seeded();
    const row = repo.update("MN", { code: "Mk", repoOrigin: null });
    expect(row).toMatchObject({ code: "Mk", project: "BetaGame", repo_origin: null });
    expect(repo.findByCode("MN")).toBeNull();
    db.close();
  });

  it("keeps its own values out of conflict checks but rejects taking another row's", () => {
    const { db, repo } = seeded();
    // 自分自身の現値をそのまま渡しても衝突にしない。
    expect(repo.update("MN", { project: "BetaGame" })).toMatchObject({ code: "MN" });
    expect(() => repo.update("MN", { project: "Concordia" })).toThrow(ProjectCodeConflictError);
    expect(() => repo.update("MN", { code: "Cc" })).toThrow(ProjectCodeConflictError);
    db.close();
  });

  it("normalizes repo_path separators on update and removes rows", () => {
    const { db, repo } = seeded();
    const row = repo.update("MN", { repoPath: "C:\\repos\\BetaGame2" });
    expect(row?.repo_path).toBe("C:/repos/BetaGame2");
    expect(repo.remove("MN")).toBe(true);
    expect(repo.remove("MN")).toBe(false);
    db.close();
  });

  it("finds a registered repo origin across URL notation and letter case", () => {
    const { db, repo } = seeded();
    expect(repo.findByRepoOrigin("ludiars/concordia")).toMatchObject({ code: "Cc" });
    expect(repo.findByRepoOrigin("git@github.com:LUDIARS/Concordia.git"))
      .toMatchObject({ code: "Cc" });
    expect(repo.findByRepoOrigin("LUDIARS/not-registered")).toBeNull();
    db.close();
  });
});
