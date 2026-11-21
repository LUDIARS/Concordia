/**
 * 終局 PR の backfill 判定 (spec/plan/2026-11-21-cc-full-scan-elimination.md FS-17)。
 * 記録済みの PR を照合の頭で 1 回だけ読むので、 終局 PR が増えても SQL の回数は増えない。
 * 判定の結果は旧来の 1 件ずつの SQL (lower(repo_origin) = lower(?) AND pr_number = ?) と同じになる。
 */
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import { reconcileTestForum, type TestForumSurfaceAdapter, type TestForumTerminalPr } from "./test-forum-reconcile.js";

function finalDetail(): RevisorLocalPrDetail {
  return {
    author: "neco", headRef: "feat/forum", baseRef: "main", body: null,
    decisionState: "auto_ok", decisionLabel: "自動マージ可", blockers: [],
    riskScore: 12, riskThreshold: 30, riskBandLabel: "low", runtimeVerificationRequired: false,
    testsPassed: 3, testsRan: 3, failedTests: [], reviewError: null, securityStatus: "passed",
    mergeable: true, autoMerge: null,
    reviewReport: { version: 1, attemptId: "job-1", headSha: "sha-head", entries: [] },
  };
}

function adapter(): TestForumSurfaceAdapter {
  let thread = 0;
  return {
    create: vi.fn(async () => ({ threadId: `thread-${++thread}` })),
    update: vi.fn(async () => undefined),
    postReviewReport: vi.fn(async () => undefined),
    postStatusChange: vi.fn(async () => undefined),
    postMerged: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function terminal(repoOrigin: string, prNumber: number): TestForumTerminalPr {
  return { pullRequestId: `pr-${prNumber}`, reviewReportVersion: 1, repoOrigin, prNumber, status: "merged", mergeCommitSha: "m".repeat(40) };
}

/** 投稿済み (閉じた) の PR を n 件記録する。 */
function seedClosed(db: Database.Database, origin: string, count: number): void {
  const repo = makeDiscordTestSurfacesRepo(db);
  for (let number = 1; number <= count; number++) {
    const row = repo.create({
      repoOrigin: origin, prNumber: number, headSha: "a".repeat(40), repoRootPath: "E:/Concordia",
      headBranch: `feat/${number}`, worktreePath: null, threadId: `t-${number}`, contentHash: null, checkStatus: null,
    });
    repo.close(row.id, "merged");
  }
}

describe("terminal PR backfill reads recorded PRs once", () => {
  it("does not issue more SQL as the number of recorded terminal PRs grows", async () => {
    const countPrepares = async (recorded: number): Promise<{ prepares: number; fetched: string[] }> => {
      const db = makeTestDb();
      seedClosed(db, "LUDIARS/Concordia", recorded);
      const terminals = [
        ...Array.from({ length: recorded }, (_, index) => terminal("LUDIARS/Concordia", index + 1)),
        terminal("LUDIARS/Concordia", 999),
      ];
      const getTerminalDetail = vi.fn(async (_id: string) => finalDetail());
      const prepare = vi.spyOn(db, "prepare");
      await reconcileTestForum({
        candidates: [], terminalPullRequests: terminals, getTerminalDetail,
        surfaces: makeDiscordTestSurfacesRepo(db), adapter: adapter(),
      });
      return { prepares: prepare.mock.calls.length, fetched: getTerminalDetail.mock.calls.map(([id]) => String(id)) };
    };
    const small = await countPrepares(3);
    const large = await countPrepares(40);
    // 未記録の #999 だけを backfill する (記録済みは詳細を取りに行かない)。
    expect(small.fetched).toEqual(["pr-999"]);
    expect(large.fetched).toEqual(["pr-999"]);
    expect(large.prepares).toBe(small.prepares);
  });

  it("matches recorded PRs case-insensitively on the origin, like the old lower() lookup", async () => {
    const db = makeTestDb();
    seedClosed(db, "ludiars/concordia", 1);
    const getTerminalDetail = vi.fn(async () => finalDetail());
    const result = await reconcileTestForum({
      candidates: [], terminalPullRequests: [terminal("LUDIARS/Concordia", 1)], getTerminalDetail,
      surfaces: makeDiscordTestSurfacesRepo(db), adapter: adapter(),
    });
    expect(getTerminalDetail).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
  });

  it("only sees PRs recorded in its own scope", async () => {
    const db = makeTestDb();
    seedClosed(db, "LUDIARS/Concordia", 1);
    const getTerminalDetail = vi.fn(async () => finalDetail());
    const result = await reconcileTestForum({
      candidates: [], terminalPullRequests: [terminal("LUDIARS/Concordia", 1)], getTerminalDetail,
      surfaces: makeDiscordTestSurfacesRepo(db, "sub:child"), adapter: adapter(),
    });
    expect(getTerminalDetail).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
  });

  it("backfills a terminal PR listed twice only once", async () => {
    const db = makeTestDb();
    const getTerminalDetail = vi.fn(async () => finalDetail());
    const result = await reconcileTestForum({
      candidates: [],
      terminalPullRequests: [terminal("LUDIARS/Concordia", 7), terminal("ludiars/concordia", 7)],
      getTerminalDetail,
      surfaces: makeDiscordTestSurfacesRepo(db), adapter: adapter(),
    });
    expect(getTerminalDetail).toHaveBeenCalledOnce();
    expect(result.created).toBe(1);
  });

  it("does not read recorded PRs when there is no terminal PR to check", async () => {
    const db = makeTestDb();
    const repo = makeDiscordTestSurfacesRepo(db);
    const listRecordedPrKeys = vi.fn(() => repo.listRecordedPrKeys?.() ?? []);
    const surfaces = { ...repo, listRecordedPrKeys };
    await reconcileTestForum({ candidates: [], terminalPullRequests: [], getTerminalDetail: vi.fn(), surfaces, adapter: adapter() });
    expect(listRecordedPrKeys).not.toHaveBeenCalled();
  });
});
