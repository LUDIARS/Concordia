import type { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import type { GeniusCard, GeniusClient } from "../inquiry/genius-client.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import { normalizeProviderEffort } from "../control/provider-preset.js";
import type {
  ModelReviewInput,
  ModelReviewOutcome,
  ModelReviewPort,
} from "./contracts.js";

const DEFAULT_SCORE_MIN = 0.6;
const REVIEW_JUDGE_TIMEOUT_MS = 30_000;

interface ModelReviewServiceDeps {
  genius: GeniusClient;
  models: Pick<ModelCatalogRepo, "list">;
  judge: RunClaudeFn;
  scoreMin?: number;
}

/**
 * Genius is the only cache/retrieval source for this flow. A miss never falls
 * through to the judge: the extra LLM call is allowed only after an accepted
 * Genius hit, so cache misses are observable instead of silently spending.
 */
export class GeniusModelReviewService implements ModelReviewPort {
  constructor(private readonly deps: ModelReviewServiceDeps) {}

  async review(input: ModelReviewInput): Promise<ModelReviewOutcome> {
    const task = input.task.trim();
    if (!task) return { status: "miss", reason: "insufficient-context" };

    const cards = await this.deps.genius.query({
      text: renderGeniusQuery(input, task),
      k: 8,
    });
    if (cards === null) return { status: "miss", reason: "genius-unavailable" };

    const scoreMin = this.deps.scoreMin ?? DEFAULT_SCORE_MIN;
    const hits = cards.filter((card) => card.score >= scoreMin);
    if (hits.length === 0) return { status: "miss", reason: "genius-no-hit" };

    const models = this.deps.models.list()
      .filter((row) => row.provider === input.provider || row.provider === "any")
      .map((row) => row.model_id);
    if (input.currentModel && !models.includes(input.currentModel)) models.push(input.currentModel);
    if (models.length === 0) return { status: "miss", reason: "invalid-judgment" };

    const judged = await this.deps.judge(
      renderJudgePrompt(input, task, models, hits),
      { model: "haiku", timeoutMs: REVIEW_JUDGE_TIMEOUT_MS },
    );
    if (!judged.ok) return { status: "miss", reason: "judge-failed" };
    const decision = parseDecision(judged.stdout, input.provider, models);
    if (!decision) return { status: "miss", reason: "invalid-judgment" };

    const geniusCardIds = hits.map((card) => card.id);
    if (decision.model === input.currentModel && decision.effort === input.currentEffort) {
      return {
        status: "unchanged",
        model: input.currentModel,
        effort: input.currentEffort,
        rationale: decision.rationale,
        geniusCardIds,
      };
    }
    return {
      status: "proposal",
      currentModel: input.currentModel,
      currentEffort: input.currentEffort,
      proposedModel: decision.model,
      proposedEffort: decision.effort,
      rationale: decision.rationale,
      geniusCardIds,
    };
  }
}

function renderGeniusQuery(input: ModelReviewInput, task: string): string {
  return [
    "Session model/effort selection judgment",
    `trigger=${input.trigger}`,
    `provider=${input.provider}`,
    `current_model=${input.currentModel ?? "(default)"}`,
    `current_effort=${input.currentEffort ?? "(default)"}`,
    `task=${task}`,
  ].join("\n");
}

function renderJudgePrompt(
  input: ModelReviewInput,
  task: string,
  models: readonly string[],
  cards: readonly GeniusCard[],
): string {
  const efforts = effortChoices(input.provider);
  const evidence = cards.map((card) => ({
    id: card.id,
    score: card.score,
    situation: card.situation ?? card.title,
    judgment: card.judgment ?? "",
    rationale: card.rationale ?? "",
    tags: card.tags ?? [],
  }));
  return [
    "You are Concordia's bounded model/effort selector.",
    "Use only the supplied Genius hit cards as judgment evidence.",
    "Choose the least expensive option that is still appropriate for the task.",
    "Do not change provider. Return one JSON object and no markdown.",
    `provider=${input.provider}`,
    `trigger=${input.trigger}`,
    `task=${task}`,
    `current_model=${input.currentModel ?? "(default)"}`,
    `current_effort=${input.currentEffort ?? "(default)"}`,
    `allowed_models=${JSON.stringify(models)}`,
    `allowed_efforts=${JSON.stringify(efforts)}`,
    `genius_hits=${JSON.stringify(evidence)}`,
    'schema={"model":"allowed model","effort":"allowed effort","rationale":"short Japanese reason"}',
  ].join("\n");
}

function parseDecision(
  stdout: string,
  provider: string,
  allowedModels: readonly string[],
): { model: string; effort: string; rationale: string } | null {
  const match = /\{[\s\S]*\}/u.exec(stdout);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof value.model !== "string" || !allowedModels.includes(value.model)) return null;
    const effort = normalizeProviderEffort(provider, value.effort);
    if (!effort) return null;
    const rationale = typeof value.rationale === "string" && value.rationale.trim()
      ? value.rationale.trim().slice(0, 500)
      : "Genius の蓄積判断に基づく候補です。";
    return { model: value.model, effort, rationale };
  } catch {
    return null;
  }
}

function effortChoices(provider: string): string[] {
  if (provider === "claude") return ["low", "medium", "high", "xhigh", "max"];
  if (provider === "codex" || provider === "codex-sdk") {
    return ["minimal", "low", "medium", "high", "xhigh", "ultra"];
  }
  return [];
}
