import { describe, expect, it, vi } from "vitest";
import type { ModelReviewOutcome, ModelReviewPort } from "../model-review/contracts.js";
import type { SessionRow } from "../shared/types.js";
import { ModelReviewContractAdapter, modelReviewProvider } from "./model-review-adapter.js";
import type { ContractField } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";

function seededContract(metadata: Record<string, unknown> | null = null) {
  const session = {
    provider: "codex-cli",
    repo_path: "E:/repo",
    branch: "feat/x",
    metadata: JSON.stringify(metadata ?? {}),
    target_project: "Cc",
  } as SessionRow;
  return seedSessionContract(session, "small fix", "discord:1");
}

function port(outcome: ModelReviewOutcome): ModelReviewPort & { review: ReturnType<typeof vi.fn> } {
  return { review: vi.fn().mockResolvedValue(outcome) };
}

const PROPOSAL: ModelReviewOutcome = {
  status: "proposal",
  currentModel: null,
  currentEffort: null,
  proposedModel: "gpt-5.3-codex",
  proposedEffort: "high",
  rationale: "Genius の蓄積判断に基づく候補です。",
  geniusCardIds: ["card-1"],
};

describe("ModelReviewContractAdapter", () => {
  it("skips the review entirely when model and effort are human decisions", async () => {
    const reviewPort = port(PROPOSAL);
    const adapter = new ModelReviewContractAdapter(reviewPort, "codex");
    const contract = seededContract({ model: "gpt-5.3-codex", effort_level: "medium" });
    contract.model = { value: "gpt-5.3-codex", decided_by: "human", rationale: "human", genius_card_ids: [] };
    contract.effort = { value: "medium", decided_by: "human", rationale: "human", genius_card_ids: [] };
    const patch = await adapter.review({ task: "small fix", repoPath: "E:/repo", unresolved: [] as ContractField[], seeded: contract });
    expect(patch).toEqual({});
    expect(reviewPort.review).not.toHaveBeenCalled();
  });

  it("passes the seeded current model/effort to the review port", async () => {
    const reviewPort = port(PROPOSAL);
    const adapter = new ModelReviewContractAdapter(reviewPort, "codex");
    const contract = seededContract({ model: "gpt-5-codex" });
    await adapter.review({ task: "small fix", repoPath: "E:/repo", unresolved: ["effort"] as ContractField[], seeded: contract });
    expect(reviewPort.review).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      currentModel: "gpt-5-codex",
      currentEffort: null,
    }));
  });

  it("records proposal values as llm decisions for all non-human fields", async () => {
    const adapter = new ModelReviewContractAdapter(port(PROPOSAL), "codex");
    const contract = seededContract({ model: "gpt-5-codex" });
    const patch = await adapter.review({ task: "small fix", repoPath: "E:/repo", unresolved: ["effort"] as ContractField[], seeded: contract });
    expect(patch.model).toMatchObject({ value: "gpt-5.3-codex", decided_by: "llm" });
    expect(patch.effort).toMatchObject({ value: "high", decided_by: "llm", genius_card_ids: ["card-1"] });
  });

  it("fills both fields when both are unresolved", async () => {
    const adapter = new ModelReviewContractAdapter(port(PROPOSAL), "codex");
    const contract = seededContract();
    const patch = await adapter.review({ task: "small fix", repoPath: "E:/repo", unresolved: ["model", "effort"] as ContractField[], seeded: contract });
    expect(patch.model).toMatchObject({ value: "gpt-5.3-codex", decided_by: "llm" });
    expect(patch.effort).toMatchObject({ value: "high", decided_by: "llm" });
  });

  it("keeps fields unresolved on a Genius miss (no fallback decision)", async () => {
    const adapter = new ModelReviewContractAdapter(port({ status: "miss", reason: "genius-no-hit" }), "codex");
    const patch = await adapter.review({ task: "small fix", repoPath: "E:/repo", unresolved: ["model", "effort"] as ContractField[], seeded: seededContract() });
    expect(patch).toEqual({ model: null, effort: null });
  });

  it("forwards the spawn trigger to model review", async () => {
    const reviewPort = port(PROPOSAL);
    const adapter = new ModelReviewContractAdapter(reviewPort, "codex");
    await adapter.review({
      trigger: "spawn",
      task: "small fix",
      repoPath: "E:/repo",
      unresolved: ["model", "effort"] as ContractField[],
      seeded: seededContract(),
    });
    expect(reviewPort.review).toHaveBeenCalledWith(expect.objectContaining({ trigger: "spawn" }));
  });

  it("does not fabricate decisions from an unchanged outcome with null current values", async () => {
    const adapter = new ModelReviewContractAdapter(
      port({ status: "unchanged", model: null, effort: null, rationale: "現状維持", geniusCardIds: [] }),
      "codex",
    );
    const patch = await adapter.review({ task: "small fix", repoPath: "E:/repo", unresolved: ["model", "effort"] as ContractField[], seeded: seededContract() });
    expect(patch).toEqual({});
  });
});

describe("modelReviewProvider", () => {
  it("normalizes session provider names to catalog providers", () => {
    expect(modelReviewProvider("claude")).toBe("claude");
    expect(modelReviewProvider("claude-code")).toBe("claude");
    expect(modelReviewProvider("codex-cli")).toBe("codex");
    expect(modelReviewProvider("codex-sdk")).toBe("codex");
    expect(modelReviewProvider("gemini")).toBeNull();
    expect(modelReviewProvider(null)).toBeNull();
  });
});
