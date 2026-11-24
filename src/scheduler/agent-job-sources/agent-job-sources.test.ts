import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAiNoteCache, readAiNoteArticles } from "./ai-note-articles.js";
import { normalizeGithubOrigin, readDependencyRepos } from "./dependency-repos.js";
import type { GitRead } from "./git-read.js";
import { parseNumstat, readReviewTargets } from "./review-targets.js";
import { parseServiceMap } from "./service-map.js";
import { toServiceStatusItems } from "./service-status-items.js";

// spec/feature/parttimer-agent-dispatch.md — 読み取り adapter
const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-agent-sources-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("agent job sources", () => {
  it("service-map の repos を読み、 不正な名前を落とす。 repos が無ければ throw", () => {
    expect(parseServiceMap({ repos: [{ name: "Concordia", code: "Cc", daily_review: true }, { name: "../evil" }, { code: "x" }] }))
      .toEqual([{ name: "Concordia", code: "Cc", dailyReview: true }]);
    expect(() => parseServiceMap({})).toThrow(/repos/);
  });

  it("numstat を読む (バイナリは null)", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n\nbad line")).toEqual([
      { added: 3, deleted: 1, path: "src/a.ts" }, { added: null, deleted: null, path: "logo.png" },
    ]);
  });

  it("週次レビューの対象は前回 HEAD からの差分を git で読み、 latest.json が無ければ前回なし", async () => {
    const root = workspace();
    mkdirSync(join(root, "Review", "Alpha"), { recursive: true });
    writeFileSync(join(root, "Review", "Alpha", "latest.json"), JSON.stringify({ head: "1".repeat(40), reviewed_at: "2026-11-17T00:00:00Z" }));
    const calls: string[][] = [];
    const git: GitRead = async (_repo, args) => {
      calls.push([...args]);
      if (args[0] === "rev-parse") return "2".repeat(40);
      if (args[0] === "rev-list") return "4";
      if (args[0] === "diff") return "10\t2\tsrc/x.ts";
      return null;
    };
    const targets = await readReviewTargets({
      workspaceRoot: root, git,
      repos: [{ name: "Alpha", code: "Al", dailyReview: true }, { name: "Beta", code: null, dailyReview: true }, { name: "Off", code: null, dailyReview: false }],
    });
    expect(targets).toEqual([
      { repo: "Alpha", code: "Al", head: "2".repeat(40), previousHead: "1".repeat(40), reviewedAt: "2026-11-17T00:00:00Z", commits: 4, files: [{ added: 10, deleted: 2, path: "src/x.ts" }] },
      { repo: "Beta", code: null, head: "2".repeat(40), previousHead: null, reviewedAt: null, commits: null, files: [] },
    ]);
    expect(calls.every((args) => !args.includes("show") && !args.includes("cat-file"))).toBe(true);
  });

  it("origin を github の https URL に正規化し、 資格情報付き・他ホストは null", () => {
    expect(normalizeGithubOrigin("git@github.com:LUDIARS/Concordia.git")).toEqual({ owner: "LUDIARS", repo: "Concordia", url: "https://github.com/LUDIARS/Concordia" });
    expect(normalizeGithubOrigin("https://github.com/LUDIARS/Ars")?.url).toBe("https://github.com/LUDIARS/Ars");
    expect(normalizeGithubOrigin("https://user:token@github.com/LUDIARS/Ars.git")).toBeNull();
    expect(normalizeGithubOrigin("https://gitlab.com/LUDIARS/Ars.git")).toBeNull();
  });

  it("依存点検は設定の org のリポだけ、 実在するマニフェストの URL を渡す。 org 未設定は throw", async () => {
    const root = workspace();
    mkdirSync(join(root, "Pub", "web"), { recursive: true });
    writeFileSync(join(root, "Pub", "package.json"), "{}");
    writeFileSync(join(root, "Pub", "web", "package.json"), "{}");
    const git: GitRead = async (repo) => (repo.endsWith("Pub") ? "git@github.com:LUDIARS/Pub.git" : "git@github.com:someone/Private.git");
    const repos = [{ name: "Pub", code: "Pb", dailyReview: false }, { name: "Private", code: null, dailyReview: false }];
    expect(await readDependencyRepos({ workspaceRoot: root, repos, githubOrg: "ludiars", git })).toEqual([{
      name: "Pub", code: "Pb", url: "https://github.com/LUDIARS/Pub",
      manifests: ["https://github.com/LUDIARS/Pub/blob/main/package.json", "https://github.com/LUDIARS/Pub/blob/main/web/package.json"],
    }]);
    await expect(readDependencyRepos({ workspaceRoot: root, repos, githubOrg: "", git })).rejects.toThrow(/github org/);
  });

  it("AIノートの cache から題・分類・日付・URL を読む (本文は読まない)", async () => {
    expect(parseAiNoteCache({ articles: [
      { page_id: "37e39cbf-bab9-81d3-b407-f39ac80f98f2", title: "分業", section: "opus", universality: "mutable", last_reviewed: "2026-07-22", note: "n" },
      { title: "" },
    ] })).toEqual([{ title: "分業", section: "opus", universality: "mutable", lastReviewed: "2026-07-22", note: "n", url: "https://www.notion.so/37e39cbfbab981d3b407f39ac80f98f2" }]);
    const root = workspace();
    mkdirSync(join(root, "fable", "ai-note-review"), { recursive: true });
    writeFileSync(join(root, "fable", "ai-note-review", "cache.json"), JSON.stringify({ articles: [] }));
    expect(await readAiNoteArticles(root)).toEqual([]);
    expect(() => parseAiNoteCache({})).toThrow(/articles/);
  });

  it("サービス稼働は本社の観測かどうかだけを付け、 拠点の識別子を落とす", () => {
    expect(toServiceStatusItems({
      generatedAt: 0, staleAfterMs: 1,
      sites: [{ id: "self", name: "HOST-A", self: true, connected: true, stale: false }, { id: "peer:p1", name: "HOST-B", self: false, connected: true, stale: false }],
      services: [
        { siteId: "self", code: "Cc", name: "Concordia", project: "Cc", repository: null, state: "up", checkedAt: 1 },
        { siteId: "peer:p1", code: "Mm", name: "Memoria", project: null, repository: "x", state: "down", checkedAt: 1 },
      ],
    })).toEqual([
      { code: "Cc", name: "Concordia", project: "Cc", state: "up", self: true },
      { code: "Mm", name: "Memoria", project: null, state: "down", self: false },
    ]);
  });
});
