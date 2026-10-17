/** @implements CC-CLOUD-09 — necessary conditions, not execution authorization. */
export const MAX_CLOUD_REPOSITORY_BYTES = 50_000_000;

/** Facts must describe the current request/revision, not a project-name heuristic. */
export interface CloudEligibilityEvidence {
  repositoryBytes: number | null;
  environmentPreparable: boolean | null;
  requiresLargeProjectClone: boolean | null;
  computeIntensiveArtifactGeneration: boolean | null;
  requiresLlmGuidance: boolean | null;
}

export type CloudIneligibilityReason =
  | "repository_size_unverified"
  | "repository_too_large"
  | "environment_not_ready"
  | "environment_unverified"
  | "large_project_clone_required"
  | "dependency_clone_unverified"
  | "artifact_generation_not_compute_intensive"
  | "artifact_load_unverified"
  | "llm_guidance_not_required"
  | "llm_guidance_unverified";

export interface CloudEligibilityDecision {
  eligible: boolean;
  reasons: readonly CloudIneligibilityReason[];
}

export function assessCloudEligibility(evidence: CloudEligibilityEvidence): CloudEligibilityDecision {
  const reasons: CloudIneligibilityReason[] = [];
  const size = evidence.repositoryBytes;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    reasons.push("repository_size_unverified");
  } else if (size > MAX_CLOUD_REPOSITORY_BYTES) {
    reasons.push("repository_too_large");
  }
  if (evidence.environmentPreparable !== true) {
    reasons.push(evidence.environmentPreparable === false ? "environment_not_ready" : "environment_unverified");
  }
  if (evidence.requiresLargeProjectClone !== false) {
    reasons.push(evidence.requiresLargeProjectClone === true ? "large_project_clone_required" : "dependency_clone_unverified");
  }
  if (evidence.computeIntensiveArtifactGeneration !== true) {
    reasons.push(evidence.computeIntensiveArtifactGeneration === false
      ? "artifact_generation_not_compute_intensive" : "artifact_load_unverified");
  }
  if (evidence.requiresLlmGuidance !== true) {
    reasons.push(evidence.requiresLlmGuidance === false ? "llm_guidance_not_required" : "llm_guidance_unverified");
  }
  return { eligible: reasons.length === 0, reasons };
}
