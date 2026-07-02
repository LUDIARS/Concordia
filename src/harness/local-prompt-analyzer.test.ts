import { describe, expect, it } from "vitest";
import {
  analyzePromptWithLocalLlm,
  heuristicPromptAnalysis,
  type PromptAnalysis,
} from "./local-prompt-analyzer.js";
import type { PromptIntentContext } from "./prompt-intent.js";

const CTX: PromptIntentContext = {
  prompt: "Concordia と Lictor に LiquidAI で prompt hook の検索タグと安全性判定を追加する",
  project: "Concordia",
  branch: "feat/prompt-analyzer",
  rules: [{ kind: "block", title: "destructive", description: "Do not destroy production data." }],
  gates: ["noMainPush"],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("heuristicPromptAnalysis", () => {
  it("extracts target services and local-LLM/search tags without a model", () => {
    const r = heuristicPromptAnalysis(CTX);
    expect(r.source).toBe("heuristic");
    expect(r.analysis.target_services).toEqual(expect.arrayContaining(["Concordia", "Lictor"]));
    expect(r.analysis.search_tags).toEqual(expect.arrayContaining(["local-llm", "hook"]));
    expect(r.verdict.decision).toBe("allow");
  });

  it("warns for destructive prompts", () => {
    const r = heuristicPromptAnalysis({ ...CTX, prompt: "本番DBのusersをDELETEして全削除する" });
    expect(r.verdict.decision).toBe("warn");
    expect(r.verdict.risk).toBe("high");
    expect(r.analysis.safety.level).toBe("danger");
  });
});

describe("analyzePromptWithLocalLlm", () => {
  it("uses OpenAI-compatible local JSON output when available", async () => {
    const fetchImpl = async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: "warn",
            risk: "medium",
            intent: "prompt hook analysis",
            concerns: ["scope"],
            search_tags: ["prompt-hook", "local-llm"],
            target_services: ["Concordia"],
            safety: { level: "caution", reasons: ["hook_behavior"] },
          } satisfies PromptAnalysis & Record<string, unknown>),
        },
      }],
    });
    const r = await analyzePromptWithLocalLlm(CTX, { fetchImpl, timeoutMs: 50 });
    expect(r.source).toBe("local-llm");
    expect(r.verdict.decision).toBe("warn");
    expect(r.analysis.search_tags).toEqual(["prompt-hook", "local-llm"]);
    expect(r.analysis.target_services).toEqual(["Concordia"]);
  });

  it("falls back to deterministic analysis when local LLM is unavailable", async () => {
    const fetchImpl = async () => { throw new Error("offline"); };
    const r = await analyzePromptWithLocalLlm(CTX, { fetchImpl, timeoutMs: 1 });
    expect(r.source).toBe("heuristic");
    expect(r.analysis.target_services).toEqual(expect.arrayContaining(["Concordia", "Lictor"]));
  });
});
