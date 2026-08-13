import type { ModelReviewPort } from "../model-review/contracts.js";
import type { ContractReviewPort } from "./review-port.js";

export class ModelReviewContractAdapter implements ContractReviewPort {
  constructor(private readonly modelReview: ModelReviewPort, private readonly provider: string) {}
  async review(input: Parameters<ContractReviewPort["review"]>[0]): Promise<Awaited<ReturnType<ContractReviewPort["review"]>>> {
    if (!input.unresolved.includes("model") && !input.unresolved.includes("effort")) return {};
    const outcome = await this.modelReview.review({ trigger: "task-change", provider: this.provider, task: input.task, currentModel: null, currentEffort: null });
    if (outcome.status === "miss") return {};
    const source = { decided_by: "llm" as const, rationale: outcome.rationale, genius_card_ids: outcome.geniusCardIds };
    const model = outcome.status === "proposal" ? outcome.proposedModel : outcome.model;
    const effort = outcome.status === "proposal" ? outcome.proposedEffort : outcome.effort;
    return { model: model ? { value: model, ...source } : null, effort: effort ? { value: effort, ...source } : null };
  }
}
