import type { CloudSubmission } from "../../src/cloud-work/submission.js";

export function cloudSubmissionFixture(provider: CloudSubmission["provider"] = "codex-cloud"): CloudSubmission {
  return { attemptId: "tokyo2070-1", taskReference: "actio:task-1", provider,
    environmentId: "test-env", sourceRevision: "a".repeat(40), instruction: "Model a street terminal",
    eligibility: { repositoryBytes: 480000, environmentPreparable: true, requiresLargeProjectClone: false,
      computeIntensiveArtifactGeneration: true, requiresLlmGuidance: true },
    standardHosted: true, gpuRequired: false, gpuVerified: false, sourceAvailable: true, artifactTransferReady: true };
}
