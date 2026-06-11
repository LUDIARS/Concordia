import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import { buildPrQueue, bucketOf } from "./queue.js";
import { renderPrQueueMarkdown } from "./render.js";
import { parseOpenPrsFromStat, normalizeRepoOrigin, prUrlFor } from "./normalize.js";

describe("pr/normalize", () => {
  it("normalizes various repo forms to owner/repo", () => {
    expect(normalizeRepoOrigin("https://github.com/LUDIARS/Concordia.git")).toBe("LUDIARS/Concordia");
    expect(normalizeRepoOrigin("git@github.com:LUDIARS/Concordia.git")).toBe("LUDIARS/Concordia");
    expect(normalizeRepoOrigin("LUDIARS/Concordia")).toBe("LUDIARS/Concordia");
    expect(normalizeRepoOrigin("C:/path/to/Repo")).toBe("C:/path/to/Repo");
  });

  it("builds a PR url only for owner/repo origins", () => {
    expect(prUrlFor("LUDIARS/Concordia", 77)).toBe("https://github.com/LUDIARS/Concordia/pull/77");
    expect(prUrlFor("C:/x", 1)).toBeNull();
  });

  it("parses open_prs[] and drops broken entries", () => {
    const parsed = parseOpenPrsFromStat({
      open_prs: [
        { repo: "LUDIARS/Concordia", number: 77, title: "ok", branch: "fix/x" },
        { repo: "LUDIARS/Concordia" }, // no number → drop
        { number: 5 }, // no repo → drop
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ repo_origin: "LUDIARS/Concordia", number: 77, head_branch: "fix/x" });
    expect(parsed[0].url).toBe("https://github.com/LUDIARS/Concordia/pull/77");
  });

  it("returns [] for payloads without open_prs", () => {
    expect(parseOpenPrsFromStat({ active_repos: [] })).toEqual([]);
    expect(parseOpenPrsFromStat(null)).toEqual([]);
  });
});

describe("pr/queue", () => {
  let db: ReturnType<typeof makeTestDb>;
  let repo: PrRecordsRepo;
  beforeEach(() => {
    db = makeTestDb();
    repo = new PrRecordsRepo(db);
  });

  it("buckets by review_state", () => {
    repo.upsertFromStat({ repo_origin: "R/x", number: 1 }); // needs_review default
    repo.upsertFromStat({ repo_origin: "R/x", number: 2 });
    repo.reconcile({ repo_origin: "R/x", number: 2, review_state: "approved" });
    repo.upsertFromStat({ repo_origin: "R/x", number: 3 });
    repo.reconcile({ repo_origin: "R/x", number: 3, review_state: "reviewing" });

    const q = buildPrQueue(repo);
    expect(q.counts.ready).toBe(1);
    expect(q.counts.in_progress).toBe(1);
    expect(q.counts.needs_review).toBe(1);
    expect(q.counts.total_active).toBe(3);
  });

  it("flat queue orders ready before in_progress before needs_review", () => {
    repo.upsertFromStat({ repo_origin: "R/x", number: 1 }); // needs_review
    repo.upsertFromStat({ repo_origin: "R/x", number: 2 });
    repo.reconcile({ repo_origin: "R/x", number: 2, review_state: "approved" }); // ready
    repo.upsertFromStat({ repo_origin: "R/x", number: 3 });
    repo.reconcile({ repo_origin: "R/x", number: 3, review_state: "changes_requested" }); // in_progress

    const q = buildPrQueue(repo);
    expect(q.queue.map((r) => bucketOf(r))).toEqual(["ready", "in_progress", "needs_review"]);
  });

  it("render injects 担当 channel mention for active PRs but not merged history", () => {
    repo.upsertFromStat({ repo_origin: "R/x", number: 1, author_session_id: "sess-a" });
    repo.upsertFromStat({ repo_origin: "R/x", number: 2, author_session_id: "sess-b" });
    repo.reconcile({ repo_origin: "R/x", number: 2, state: "merged", merged_at: 100 });
    const q = buildPrQueue(repo);
    const md = renderPrQueueMarkdown(q, {
      mentionFor: (row) => (row.author_session_id === "sess-a" ? "<#chan-a>" : null),
    });
    expect(md).toContain("担当 <#chan-a>"); // active PR #1
    // merged section never carries a mention even if a resolver matched
    const mergedLine = md.split("\n").find((l) => l.includes("R/x#2"));
    expect(mergedLine).toBeDefined();
    expect(mergedLine).not.toContain("担当");
  });
});
