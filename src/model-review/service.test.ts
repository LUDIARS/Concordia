import { describe, expect, it, vi } from "vitest";
import { GeniusModelReviewService } from "./service.js";
import type { GeniusClient } from "../inquiry/genius-client.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";

const models = {
  list: () => [
    { provider: "codex", model_id: "gpt-5.6-sol" },
    { provider: "codex", model_id: "gpt-5.6-terra" },
  ] as ReturnType<import("../db/model-catalog-repo.js").ModelCatalogRepo["list"]>,
};

describe("GeniusModelReviewService", () => {
  it("does not call the judge on a Genius cache miss", async () => {
    const genius: GeniusClient = { query: vi.fn(async () => []) };
    const judge = vi.fn() as unknown as RunClaudeFn;
    const service = new GeniusModelReviewService({ genius, models, judge });

    await expect(service.review(baseInput())).resolves.toEqual({
      status: "miss",
      reason: "genius-no-hit",
    });
    expect(judge).not.toHaveBeenCalled();
  });

  it("creates a switch proposal only after an accepted Genius hit", async () => {
    const genius: GeniusClient = {
      query: vi.fn(async () => [{
        id: "card-1",
        title: "調査実装は中位モデルを使う",
        situation: "調査実装",
        judgment: "コストを抑えた中位モデルを使う",
        rationale: "強推論は設計判断へ温存する",
        score: 0.82,
      }]),
    };
    const judge: RunClaudeFn = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        model: "gpt-5.6-terra",
        effort: "medium",
        rationale: "調査実装にはTerra/mediumで十分です。",
      }),
      stderr: "",
    }));
    const service = new GeniusModelReviewService({ genius, models, judge });

    await expect(service.review(baseInput())).resolves.toMatchObject({
      status: "proposal",
      proposedModel: "gpt-5.6-terra",
      proposedEffort: "medium",
      geniusCardIds: ["card-1"],
    });
    expect(judge).toHaveBeenCalledOnce();
  });
});

function baseInput() {
  return {
    trigger: "spawn" as const,
    provider: "codex",
    task: "既存コードを調査して小さな実装方針をまとめる",
    currentModel: "gpt-5.6-sol",
    currentEffort: "xhigh",
  };
}
