export type ModelReviewTrigger = "spawn" | "task-change";

export interface ModelReviewInput {
  trigger: ModelReviewTrigger;
  provider: string;
  task: string;
  currentModel: string | null;
  currentEffort: string | null;
}

export type ModelReviewMissReason =
  | "insufficient-context"
  | "genius-unavailable"
  | "genius-no-hit"
  | "judge-failed"
  | "invalid-judgment";

export type ModelReviewOutcome =
  | {
      status: "miss";
      reason: ModelReviewMissReason;
    }
  | {
      status: "unchanged";
      model: string | null;
      effort: string | null;
      rationale: string;
      geniusCardIds: string[];
    }
  | {
      status: "proposal";
      currentModel: string | null;
      currentEffort: string | null;
      proposedModel: string;
      proposedEffort: string;
      rationale: string;
      geniusCardIds: string[];
    };

export interface ModelReviewPort {
  review(input: ModelReviewInput): Promise<ModelReviewOutcome>;
}

export interface RuntimeModelReviewApplyResult {
  ok: boolean;
  message: string;
}
