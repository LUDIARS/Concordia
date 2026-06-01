import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./schema.js";
import { PrRecordsRepo } from "./pr-records-repo.js";

let db: Database.Database;
let repo: PrRecordsRepo;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  repo = new PrRecordsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("PrRecordsRepo / upsertFromStat", () => {
  it("inserts a new PR as open + needs_review", () => {
    const row = repo.upsertFromStat({
      repo_origin: "LUDIARS/Concordia",
      number: 77,
      title: "Fix discord",
      head_branch: "fix/x",
      author_session_id: "sess-a",
      persona_name: "火盛 渋",
    });
    expect(row.state).toBe("open");
    expect(row.review_state).toBe("needs_review");
    expect(row.author_session_id).toBe("sess-a");
    expect(row.persona_name).toBe("火盛 渋");
  });

  it("is idempotent on (repo_origin, number) — second report does not duplicate", () => {
    repo.upsertFromStat({ repo_origin: "LUDIARS/Concordia", number: 77, title: "v1" });
    repo.upsertFromStat({ repo_origin: "LUDIARS/Concordia", number: 77, title: "v2" });
    expect(repo.listActive()).toHaveLength(1);
    expect(repo.findByKey("LUDIARS/Concordia", 77)?.title).toBe("v2");
  });

  it("does not overwrite author once set", () => {
    repo.upsertFromStat({ repo_origin: "R/x", number: 1, author_session_id: "first" });
    repo.upsertFromStat({ repo_origin: "R/x", number: 1, author_session_id: "second" });
    expect(repo.findByKey("R/x", 1)?.author_session_id).toBe("first");
  });

  it("does not revert merged state back to open on a later stat report", () => {
    repo.upsertFromStat({ repo_origin: "R/x", number: 1 });
    repo.reconcile({ repo_origin: "R/x", number: 1, state: "merged", merged_at: 1000 });
    repo.upsertFromStat({ repo_origin: "R/x", number: 1, title: "still reported" });
    expect(repo.findByKey("R/x", 1)?.state).toBe("merged");
  });
});

describe("PrRecordsRepo / reconcile", () => {
  it("updates state/ci/review and moves row out of active", () => {
    repo.upsertFromStat({ repo_origin: "R/x", number: 5 });
    const changed = repo.reconcile({
      repo_origin: "R/x",
      number: 5,
      state: "merged",
      ci_status: "success",
      review_state: "approved",
      merged_at: 2000,
    });
    expect(changed).toBe(true);
    expect(repo.listActive()).toHaveLength(0);
    expect(repo.listRecentlyMerged()).toHaveLength(1);
  });

  it("returns false for unknown PR (does not insert)", () => {
    const changed = repo.reconcile({ repo_origin: "R/none", number: 9, state: "closed" });
    expect(changed).toBe(false);
    expect(repo.findByKey("R/none", 9)).toBeNull();
  });

  it("distinctActiveOrigins lists only origins with open/draft rows", () => {
    repo.upsertFromStat({ repo_origin: "A/a", number: 1 });
    repo.upsertFromStat({ repo_origin: "B/b", number: 2 });
    repo.reconcile({ repo_origin: "B/b", number: 2, state: "merged" });
    expect(repo.distinctActiveOrigins().sort()).toEqual(["A/a"]);
  });
});
