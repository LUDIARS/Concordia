import { describe, expect, it } from "vitest";
import { createLudiarsCollector, markdownToPlain, specSummary, type KnowledgeProject } from "./knowledge-ludiars.js";
import { createRevisorCollector } from "./knowledge-revisor.js";
import type { KnowledgeCollection } from "./knowledge-types.js";

const projects: KnowledgeProject[] = [
  { code: "Ex", project: "Examplia", repoOrigin: "https://github.com/example-org/Examplia", repoPath: "/w/Examplia" },
  { code: "Hd", project: "Hiddenia", repoOrigin: null, repoPath: "/w/Hiddenia" },
];

const files: Record<string, string> = {
  "/w/Examplia/README.md": "# Examplia\n\n![badge](x.svg)\n\nExamplia は素材を集めて並べるサービスです。 詳しくは [spec](spec/a.md)。\n\n```sh\nnpm start\n```\n",
  "/w/Examplia/spec/feature/a.md": "---\ntitle: \"素材の一覧\"\ndescription: \"素材元から候補を読み、 決まった点数で並べる。\"\n---\n# 本文\n",
  "/w/Hiddenia/README.md": "# Hiddenia\n\n本社だけで動かしている内部の道具です。 外には出さない前提。\n",
};
const dirs: Record<string, string[]> = { "/w/Examplia/spec/feature": ["a.md"] };

function collector(publicProjects: string[]) {
  return createLudiarsCollector({
    projects: () => projects,
    publicProjects: () => publicProjects,
    readHead: async (path, max) => (files[path] ? files[path]!.slice(0, max) : null),
    listMarkdown: async (dir) => dirs[dir] ?? [],
  });
}

describe("LUDIARS collector", () => {
  it("collects the project list, README head and spec summary with the project's scope", async () => {
    const out = await collector(["Ex"])({ cursor: null, full: true }) as KnowledgeCollection;
    expect(out.full).toBe(true);
    const byKey = new Map(out.docs.map((d) => [d.docKey, d]));
    expect(byKey.get("project:Ex")).toMatchObject({ scope: "public", docType: "project" });
    expect(byKey.get("project:Ex")!.text).toContain("略称 Ex は Examplia");
    expect(byKey.get("repo:Ex:README.md")!.text).not.toContain("npm start");
    expect(byKey.get("repo:Ex:spec/feature/a.md")).toMatchObject({ scope: "public", path: "spec/feature/a.md", text: "素材元から候補を読み、 決まった点数で並べる。" });
    // 公開と明示していないプロジェクトは hq
    expect(byKey.get("project:Hd")!.scope).toBe("hq");
    expect(byKey.get("repo:Hd:README.md")!.scope).toBe("hq");
  });
});

describe("markdown helpers", () => {
  it("strips code, images and links", () => {
    expect(markdownToPlain("# T\n\n[a](b) ![i](j)\n```\ncode\n```")).toBe("T\n\na");
  });

  it("falls back to the first paragraph without frontmatter", () => {
    expect(specSummary("# 題\n\n短い\n\nこれは十分に長い最初の段落で、 要約として使われるはずの文です。")).toEqual({
      title: "題", summary: "これは十分に長い最初の段落で、 要約として使われるはずの文です。",
    });
  });
});

describe("Revisor collector", () => {
  it("groups merged titles of the last 7 days by repository and keeps unknown repositories hq", async () => {
    const now = Date.parse("2026-10-18T00:00:00Z");
    const out = await createRevisorCollector({
      nowMs: () => now,
      projects: () => projects,
      publicProjects: () => ["Ex"],
      mergedPrs: async () => [
        { repository: "example-org/Examplia", title: "feat: 素材を足す", mergedAtMs: now - 86_400_000 },
        { repository: "example-org/Examplia", title: "old", mergedAtMs: now - 8 * 86_400_000 },
        { repository: "example-org/Unlisted", title: "fix: なにか", mergedAtMs: now - 1000 },
      ],
    })({ cursor: null, full: true }) as KnowledgeCollection;
    expect(out.docs.map((d) => [d.docKey, d.scope, d.text])).toEqual([
      ["merged:example-org/Examplia", "public", "・feat: 素材を足す"],
      ["merged:example-org/Unlisted", "hq", "・fix: なにか"],
    ]);
  });
});
