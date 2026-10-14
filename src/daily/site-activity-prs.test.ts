import { describe, expect, it } from "vitest";
import { indexSessionPrs, type GithubPrSource, type LocalPrSource } from "./site-activity-prs.js";

function local(patch: Partial<LocalPrSource>): LocalPrSource {
  return { number: 1, repository: "LUDIARS/Concordia", title: "local PR", status: "open", sessionId: "s-1", updatedAt: "2026-10-14T00:00:00Z", ...patch };
}

function github(patch: Partial<GithubPrSource>): GithubPrSource {
  return {
    repo_origin: "LUDIARS/Concordia",
    number: 10,
    title: "GitHub PR",
    url: "https://github.com/LUDIARS/Concordia/pull/10",
    state: "merged",
    author_session_id: "s-1",
    updated_at: 1_000,
    ...patch,
  };
}

describe("indexSessionPrs", () => {
  it("提出元セッションの PR だけを、 番号・リポジトリ・題名・状態・URL で載せる", () => {
    const index = indexSessionPrs(["s-1", "s-2"], [local({}), local({ number: 2, sessionId: "other" }), local({ number: 3, sessionId: null })], [github({})]);
    expect(index.get("s-1")).toEqual([
      { source: "local", repo: "LUDIARS/Concordia", number: 1, title: "local PR", state: "open", url: null },
      { source: "github", repo: "LUDIARS/Concordia", number: 10, title: "GitHub PR", state: "merged", url: "https://github.com/LUDIARS/Concordia/pull/10" },
    ]);
    expect(index.has("s-2")).toBe(false);
    expect(index.has("other")).toBe(false);
  });

  it("同じ PR は 1 件にし、 新しい順に上限まで載せる", () => {
    const githubPrs = Array.from({ length: 8 }, (_, i) => github({ number: i + 1, updated_at: i }));
    const index = indexSessionPrs(["s-1"], [], [...githubPrs, github({ number: 8, updated_at: 7 })], 5);
    expect(index.get("s-1")?.map((pr) => pr.number)).toEqual([8, 7, 6, 5, 4]);
  });

  it("長い題名は切り、 http(s) でない URL と不正な番号は載せない", () => {
    const index = indexSessionPrs(["s-1"], [local({ number: 0 })], [github({ title: "あ".repeat(300), url: "javascript:alert(1)" })]);
    const prs = index.get("s-1") ?? [];
    expect(prs).toHaveLength(1);
    expect(prs[0]?.title.length).toBe(150);
    expect(prs[0]?.url).toBeNull();
  });
});
