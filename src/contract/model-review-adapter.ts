import type { ModelReviewPort } from "../model-review/contracts.js";
import type { SessionContract } from "./schema.js";
import type { ContractReviewPort } from "./review-port.js";

/** session provider 名を model catalog の provider へ正規化する。 対象外 provider は null。 */
export function modelReviewProvider(provider: string | null): "claude" | "codex" | null {
  if (provider === "claude" || provider === "claude-code") return "claude";
  if (provider === "codex" || provider === "codex-cli" || provider === "codex-sdk") return "codex";
  return null;
}

/**
 * 旧 model-review (Genius hit → 小型 judge) を契約の LLM tier として吸収する adapter。
 * runtime の seed 値は「現在値」として判定へ渡し、 human 決定以外を再評価する。
 * miss は「記録して現状維持」ではなく未決のまま返し、 質問カード (human tier) に委ねる。
 */
export class ModelReviewContractAdapter implements ContractReviewPort {
  constructor(private readonly modelReview: ModelReviewPort, private readonly provider: string) {}
  async review(input: Parameters<ContractReviewPort["review"]>[0]): Promise<Partial<SessionContract>> {
    const wantModel = input.seeded.model?.decided_by !== "human";
    const wantEffort = input.seeded.effort?.decided_by !== "human";
    if (!wantModel && !wantEffort) return {};
    const outcome = await this.modelReview.review({
      trigger: input.trigger ?? "task-change",
      provider: this.provider,
      task: input.task,
      currentModel: input.seeded.model?.value ?? null,
      currentEffort: input.seeded.effort?.value ?? null,
    });
    if (outcome.status === "miss") {
      return {
        ...(wantModel ? { model: null } : {}),
        ...(wantEffort ? { effort: null } : {}),
      };
    }
    const source = { decided_by: "llm" as const, rationale: outcome.rationale, genius_card_ids: outcome.geniusCardIds };
    const model = outcome.status === "proposal" ? outcome.proposedModel : outcome.model;
    const effort = outcome.status === "proposal" ? outcome.proposedEffort : outcome.effort;
    const patch: Partial<SessionContract> = {};
    if (wantModel && model) patch.model = { value: model, ...source };
    if (wantEffort && effort) patch.effort = { value: effort, ...source };
    return patch;
  }
}
