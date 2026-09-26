import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DomainReviewRepo, type DomainReviewPostListRow } from "../db/domain-review-repo.js";
import { contractMetrics } from "../harness/reliability/ontime-metrics.js";
import listingContract from "./post-listing.contract.js";
import {
  DOMAIN_REVIEW_POSTS_DEFAULT_LIMIT,
  DOMAIN_REVIEW_POSTS_MAX_LIMIT,
  listDomainReviewPosts,
  resolvePostListLimit,
  summarizeDomainReviewPost,
} from "./post-listing.js";

const SUMMARY_FIELDS = [
  "code", "coreDomains", "id", "layerViolations", "layers",
  "planQuestions", "postedAt", "repoOrigin", "source", "trigger",
];

function listRow(overrides: Partial<DomainReviewPostListRow> = {}): DomainReviewPostListRow {
  return {
    id: 7,
    code: "Cc",
    repo_path: "E:/Document/Ars/Concordia",
    anatomia_project_id: "concordia",
    plan_task_hash: "0123456789abcdef",
    trigger_kind: "plan",
    platform: "discord",
    channel_id: "chan-secret",
    message_id: "msg-secret",
    questions: JSON.stringify(["問いの本文 1", "問いの本文 2"]),
    created_at: Date.UTC(2026, 8, 26, 9, 0, 0),
    report_source: "prepared",
    core_domain_count: 5,
    layer_count: 3,
    layer_violation_count: 0,
    repo_origin: "https://github.com/LUDIARS/Concordia.git",
    ...overrides,
  };
}

/** Process-wide observe counters for one contract; compare deltas because vitest shares the process. */
function observed(contractId: string): { observed: number; violations: number } {
  const entries = contractMetrics().contracts.filter((entry) => entry.contract === contractId);
  return {
    observed: entries.reduce((sum, entry) => sum + entry.observed, 0),
    violations: entries.reduce((sum, entry) => sum + entry.violations + entry.predicate_errors, 0),
  };
}

describe("resolvePostListLimit", () => {
  it("指定が無い・空・数値でなければ既定の 20 件", () => {
    for (const value of [undefined, null, "", "  ", "abc"]) {
      expect(resolvePostListLimit(value)).toBe(DOMAIN_REVIEW_POSTS_DEFAULT_LIMIT);
    }
  });

  it("上限 100 を超える指定は 100 に丸め、1 未満は 1 にする", () => {
    expect(resolvePostListLimit("500")).toBe(DOMAIN_REVIEW_POSTS_MAX_LIMIT);
    expect(resolvePostListLimit(101)).toBe(100);
    expect(resolvePostListLimit("0")).toBe(1);
    expect(resolvePostListLimit("-5")).toBe(1);
    expect(resolvePostListLimit("7.9")).toBe(7);
  });
});

describe("summarizeDomainReviewPost", () => {
  it("一覧の 10 項目だけを返し、問いの本文・channel / message id を含めない", () => {
    const summary = summarizeDomainReviewPost(listRow());
    expect(Object.keys(summary).sort()).toEqual(SUMMARY_FIELDS);
    expect(summary).toEqual({
      id: 7,
      code: "Cc",
      repoOrigin: "https://github.com/LUDIARS/Concordia.git",
      trigger: "plan",
      source: "prepared",
      postedAt: "2026-09-26T09:00:00.000Z",
      coreDomains: 5,
      layers: 3,
      layerViolations: 0,
      planQuestions: 2,
    });
    const text = JSON.stringify(summary);
    expect(text).not.toContain("問いの本文");
    expect(text).not.toContain("secret");
  });

  it("件数を記録していない旧い投稿は null のまま返す (0 で埋めない)", () => {
    const summary = summarizeDomainReviewPost(listRow({
      report_source: null,
      core_domain_count: null,
      layer_count: null,
      layer_violation_count: null,
      questions: "{壊れた",
    }));
    expect(summary).toMatchObject({ source: null, coreDomains: null, layers: null, layerViolations: null, planQuestions: 0 });
  });
});

describe("listDomainReviewPosts", () => {
  it("解決した件数で repo を引き、要約へ写す", () => {
    const listByCode = vi.fn(() => [listRow({ id: 9 }), listRow({ id: 8, created_at: Date.UTC(2026, 8, 25) })]);
    const result = listDomainReviewPosts({ listByCode }, { code: "Cc", limit: "1000" });
    expect(listByCode).toHaveBeenCalledWith("Cc", DOMAIN_REVIEW_POSTS_MAX_LIMIT);
    expect(result.map((post) => post.id)).toEqual([9, 8]);
  });

  it("C-10 / C-11 を observe し、台帳から引いた一覧で違反を出さない", () => {
    const db = makeTestDb();
    const repo = new DomainReviewRepo(db);
    for (const [index, code] of ["Cc", "Br", "Cc"].entries()) {
      repo.recordPost({
        code,
        repoPath: "E:/Document/Ars/Concordia",
        anatomiaProjectId: "concordia",
        planTaskHash: null,
        triggerKind: "manual",
        platform: "discord",
        channelId: "chan-1",
        messageId: `msg-${index}`,
        questions: [],
      });
    }
    const beforeList = observed("C-10");
    const beforeSummary = observed("C-11");

    const result = listDomainReviewPosts(repo, { code: "Cc" });

    expect(result.map((post) => post.code)).toEqual(["Cc", "Cc"]);
    expect(observed("C-10").observed).toBe(beforeList.observed + 1);
    expect(observed("C-10").violations).toBe(beforeList.violations);
    expect(observed("C-11").observed).toBe(beforeSummary.observed + 2);
    expect(observed("C-11").violations).toBe(beforeSummary.violations);
  });
});

describe("post-listing contract predicates", () => {
  const newer = summarizeDomainReviewPost(listRow({ id: 2, created_at: Date.UTC(2026, 8, 26) }));
  const older = summarizeDomainReviewPost(listRow({ id: 1, created_at: Date.UTC(2026, 8, 25) }));
  const posts = { listByCode: () => [] };

  it("C-11 は本文や宛先の項目が 1 つでも混ざれば違反にする", () => {
    expect(listingContract.post(newer, listRow())).toBe(true);
    expect(listingContract.post({ ...newer, message_id: "msg" }, listRow())).toBe(false);
    const missing: Record<string, unknown> = { ...newer };
    delete missing.planQuestions;
    expect(listingContract.post(missing, listRow())).toBe(false);
  });

  it("C-10 は順序・件数・code の絞り込みを確かめる", () => {
    expect(listingContract.post([newer, older], posts, { code: "Cc" })).toBe(true);
    expect(listingContract.post([older, newer], posts, { code: "Cc" })).toBe(false);
    expect(listingContract.post([newer, older], posts, { code: "Br" })).toBe(false);
    expect(listingContract.post([newer, older], posts, { code: null, limit: "1" })).toBe(false);
    // 順序は正しいまま既定の 20 件を 1 件だけ超える一覧。
    const overDefault = Array.from({ length: 21 }, (_, index) => summarizeDomainReviewPost(listRow({ id: 100 - index })));
    expect(listingContract.post(overDefault.slice(0, 20), posts, { code: null })).toBe(true);
    expect(listingContract.post(overDefault, posts, { code: null })).toBe(false);
  });
});
