import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { GithubActorsRepo } from "./github-actors-repo.js";

function repo() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return { db, actors: new GithubActorsRepo(db) };
}

describe("GithubActorsRepo", () => {
  it("同じ login は大文字小文字を畳んで 1 行に積み上げる", () => {
    const { db, actors } = repo();
    actors.touch({ login: "Neco", kind: "author", repoOrigin: "LUDIARS/Concordia", issueNumber: 1 });
    const row = actors.touch({ login: "neco", kind: "labeler", repoOrigin: "LUDIARS/Ars", issueNumber: 7 });

    expect(actors.list()).toHaveLength(1);
    expect(row?.seen_count).toBe(2);
    // 最後に見かけた状況を持つ。 表示名は GitHub 上の表記で上書きする。
    expect(row?.display_login).toBe("neco");
    expect(row?.last_kind).toBe("labeler");
    expect(row?.last_repo).toBe("LUDIARS/Ars");
    expect(row?.last_issue_number).toBe(7);
    db.close();
  });

  it("空 login は記録しない", () => {
    const { db, actors } = repo();
    // ポーリング経路は actor を確定できないことがある。 空行を候補として出さない。
    expect(actors.touch({ login: "  ", kind: "labeler", repoOrigin: "LUDIARS/Concordia", issueNumber: 1 })).toBeNull();
    expect(actors.list()).toEqual([]);
    db.close();
  });

  it("直近に見かけた順で返す", () => {
    const { db, actors } = repo();
    actors.touch({ login: "first", kind: "author", repoOrigin: "LUDIARS/Concordia", issueNumber: 1 });
    actors.touch({ login: "second", kind: "author", repoOrigin: "LUDIARS/Concordia", issueNumber: 2 });
    db.prepare("UPDATE github_actors SET last_seen_at = ? WHERE login = ?").run(1, "first");

    expect(actors.list().map((row) => row.login)).toEqual(["second", "first"]);
    db.close();
  });
});
