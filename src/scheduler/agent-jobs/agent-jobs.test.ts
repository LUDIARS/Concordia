import { describe, expect, it } from "vitest";
import { INSTRUCTION_LIMITS } from "../../agent-instructions/instruction-policy.js";
import { selectAiNoteTargets, type AiNoteArticle } from "./ai-note-biweekly-review.js";
import { REVIEW_FILES_PER_REPO } from "./ludiars-review-weekly.js";
import { AGENT_JOB_NAMES, createAgentJobRegistry, hasAgentJob, type AgentJobSources } from "./registry.js";
import { buildAgentJobResultPost, buildFallbackPost } from "./result-post.js";

// spec/feature/parttimer-agent-dispatch.md — ジョブごとの本文・data builder・結果の文面
const firedAt = new Date("2026-11-24T00:00:00Z");
const context = { firedAt, targetKey: "", args: { date: "2026-11-24" } };

function sources(overrides: Partial<AgentJobSources> = {}): AgentJobSources {
  return {
    services: async () => [
      { code: "Mm", name: "Memoria", project: "Mm", state: "up", self: true },
      { code: "Cc", name: "Concordia", project: "Cc", state: "down", self: true },
      { code: "Ex", name: "Excubitor", project: "Ex", state: "unknown", self: false },
    ],
    reviewTargets: async () => [
      { repo: "Same", code: "Sa", head: "a".repeat(40), previousHead: "a".repeat(40), reviewedAt: null, commits: 0, files: [] },
      { repo: "Changed", code: "Ch", head: "b".repeat(40), previousHead: "c".repeat(40), reviewedAt: "2026-11-17", commits: 3,
        files: Array.from({ length: 40 }, (_, index) => ({ path: `f${index}.ts`, added: index, deleted: 0 })) },
    ],
    aiNoteArticles: async () => [],
    dependencyRepos: async () => [
      { name: "Concordia", code: "Cc", url: "https://github.com/LUDIARS/Concordia", manifests: ["https://github.com/LUDIARS/Concordia/blob/main/package.json"] },
      { name: "Docs", code: null, url: "https://github.com/LUDIARS/Docs", manifests: [] },
    ],
    lastDoneSummary: (job) => (job === "deps-sweep-daily" ? "前回: 更新候補 2 件" : null),
    ...overrides,
  };
}

describe("agent jobs", () => {
  it("INV-06: 外部エージェントへ回せるのは data builder のあるジョブだけ", () => {
    expect([...AGENT_JOB_NAMES].sort()).toEqual(["ai-note-biweekly-review", "deps-sweep-daily", "ludiars-review-weekly", "ludiars-status-daily"]);
    expect(hasAgentJob("vulnerability-response-daily")).toBe(false);
    expect(createAgentJobRegistry(sources()).get("kaizen-daily")).toBeNull();
  });

  it("どのジョブの本文も指令の上限に収まり、 書き込み・PR をしないと明記する", () => {
    const registry = createAgentJobRegistry(sources());
    for (const name of AGENT_JOB_NAMES) {
      const spec = registry.get(name)!;
      expect(Array.from(spec.body).length).toBeLessThanOrEqual(INSTRUCTION_LIMITS.bodyChars);
      expect(spec.body).toContain("書き込み・通知・PR 作成");
    }
  });

  it("日報は止まっているサービスを先にし、 拠点名を渡さない", async () => {
    const data = await createAgentJobRegistry(sources()).get("ludiars-status-daily")!.buildData(context);
    expect((data.services as { code: string }[]).map((service) => service.code)).toEqual(["Cc", "Ex", "Mm"]);
    expect(JSON.stringify(data)).not.toMatch(/siteId|peer:/);
  });

  it("週次レビューは変更のあるリポを先にし、 ファイルは差分の大きい順に上限まで (本文は渡さない)", async () => {
    const data = await createAgentJobRegistry(sources()).get("ludiars-review-weekly")!.buildData(context);
    const repos = data.repos as { repo: string; status: string; files: { path: string }[]; files_total: number }[];
    expect(repos.map((repo) => [repo.repo, repo.status])).toEqual([["Changed", "changed"], ["Same", "unchanged"]]);
    expect(repos[0]!.files).toHaveLength(REVIEW_FILES_PER_REPO);
    expect(repos[0]!.files[0]!.path).toBe("f39.ts");
    expect(repos[0]!.files_total).toBe(40);
  });

  it("依存点検はマニフェストのあるリポだけを渡し、 前回の要約を添える", async () => {
    const data = await createAgentJobRegistry(sources()).get("deps-sweep-daily")!.buildData(context);
    expect((data.repos as { name: string }[]).map((repo) => repo.name)).toEqual(["Concordia"]);
    expect(data.previous_summary).toBe("前回: 更新候補 2 件");
  });

  it("AIノートは evergreen と 14 日以内のものを外し、 未レビュー・古い順に並べる", () => {
    const article = (title: string, universality: string, lastReviewed: string | null): AiNoteArticle => ({
      title, section: null, universality, lastReviewed, note: null, url: null,
    });
    const picked = selectAiNoteTargets([
      article("evergreen", "evergreen", "2026-01-01"),
      article("recent", "mutable", "2026-11-20"),
      article("old", "mutable", "2026-10-01"),
      article("never", "mutable", null),
      article("older", "mutable", "2026-09-01"),
    ], firedAt);
    expect(picked.map((item) => item.title)).toEqual(["never", "older", "old"]);
  });

  it("結果と戻しの文面は mention とリンクを無効化し、 上限に収める", () => {
    const post = buildAgentJobResultPost("提案", {
      jobName: "j", title: "@here 週次", agent: "dots", status: "done", summary: "s".repeat(3000),
      detail: { items: Array.from({ length: 15 }, (_, index) => `見る: https://x.example/${index}`) }, instructionId: "inst:dots:1",
    });
    expect(post).not.toMatch(/@here|https:\/\//u);
    expect(post).toContain("…ほか 5 件");
    expect(post.length).toBeLessThanOrEqual(1900);
    expect(buildFallbackPost({ title: "<@1> 日報", agent: "muse", instructionId: "inst:muse:1", invoked: true })).not.toContain("<@1>");
  });
});
