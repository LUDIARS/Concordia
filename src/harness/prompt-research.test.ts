import { describe, expect, it } from "vitest";
import { collectPromptResearch } from "./prompt-research.js";
import type { PromptAnalysis } from "./local-prompt-analyzer.js";

const ANALYSIS: PromptAnalysis = {
  search_tags: ["prompt-hook", "graph"],
  target_services: ["Concordia"],
  safety: { level: "safe", reasons: [] },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("collectPromptResearch", () => {
  it("returns detailed graph data when related count is under threshold", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/graph")) {
        return json({
          nodes: [
            { id: "n1", name: "PromptHook", kind: "function", sourceRange: { filePath: "src/hook.ts" } },
            { id: "n2", name: "Other", kind: "function", sourceRange: { filePath: "src/other.ts" } },
          ],
          edges: [{ from: "n1", to: "n2", kind: "calls" }],
        });
      }
      return json({ summary: { flagged: 2, shown: 2, truncated: false } });
    };
    const r = await collectPromptResearch(ANALYSIS, { prompt: "prompt hook graph" }, {
      fetchImpl,
      threshold: 30,
      timeoutMs: 50,
    });
    expect(r.threshold).toBe(30);
    expect(r.projects).toEqual(["Concordia"]);
    expect(r.anatomia[0].stage).toBe("detail");
    expect(r.anatomia[0].related_count).toBe(2);
    expect(r.anatomia[0].nodes?.[0]?.name).toBe("PromptHook");
    expect(r.thaleia[0]).toMatchObject({ ok: true, flagged_count: 2, shown_count: 2, truncated: false });
  });

  it("keeps graph detail at summary stage when related count exceeds threshold", async () => {
    const nodes = Array.from({ length: 31 }, (_, i) => ({
      id: `n${i}`,
      name: `PromptHook${i}`,
      kind: "function",
      sourceRange: { filePath: `src/hook-${i}.ts` },
    }));
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/graph")) return json({ nodes, edges: [] });
      return json({ summary: { flagged: 40, shown: 30, truncated: true } });
    };
    const r = await collectPromptResearch(ANALYSIS, { prompt: "prompt hook graph" }, {
      fetchImpl,
      threshold: 30,
      timeoutMs: 50,
    });
    expect(r.anatomia[0].stage).toBe("summary");
    expect(r.anatomia[0].related_count).toBe(31);
    expect(r.anatomia[0].nodes).toBeUndefined();
    expect(r.thaleia[0]).toMatchObject({ flagged_count: 40, shown_count: 30, truncated: true });
  });
});
