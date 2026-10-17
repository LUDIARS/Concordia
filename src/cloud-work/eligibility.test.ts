import { describe, expect, it } from "vitest";
import { assessCloudEligibility, MAX_CLOUD_REPOSITORY_BYTES, type CloudEligibilityEvidence } from "./eligibility.js";

const eligible: CloudEligibilityEvidence = {
  repositoryBytes: MAX_CLOUD_REPOSITORY_BYTES,
  environmentPreparable: true,
  requiresLargeProjectClone: false,
  computeIntensiveArtifactGeneration: true,
  requiresLlmGuidance: true,
};

describe("cloud admission (CC-CLOUD-09)", () => {
  it("includes the 50 MB boundary only when every other condition is met", () => {
    expect(assessCloudEligibility(eligible)).toEqual({ eligible: true, reasons: [] });
    expect(assessCloudEligibility({ ...eligible, repositoryBytes: MAX_CLOUD_REPOSITORY_BYTES + 1 }))
      .toEqual({ eligible: false, reasons: ["repository_too_large"] });
  });

  it.each([null, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("does not invent a size for %s", (repositoryBytes) => {
    expect(assessCloudEligibility({ ...eligible, repositoryBytes }).reasons).toContain("repository_size_unverified");
  });

  it.each([
    ["environmentPreparable", false, "environment_not_ready"],
    ["environmentPreparable", null, "environment_unverified"],
    ["requiresLargeProjectClone", true, "large_project_clone_required"],
    ["requiresLargeProjectClone", null, "dependency_clone_unverified"],
    ["computeIntensiveArtifactGeneration", false, "artifact_generation_not_compute_intensive"],
    ["computeIntensiveArtifactGeneration", null, "artifact_load_unverified"],
    ["requiresLlmGuidance", false, "llm_guidance_not_required"],
    ["requiresLlmGuidance", null, "llm_guidance_unverified"],
  ] as const)("rejects %s=%s independently of all other passing conditions", (field, value, reason) => {
    expect(assessCloudEligibility({ ...eligible, [field]: value })).toEqual({ eligible: false, reasons: [reason] });
  });

  it("returns all missing evidence rather than allowing unknown conditions", () => {
    const result = assessCloudEligibility({ repositoryBytes: null, environmentPreparable: null,
      requiresLargeProjectClone: null, computeIntensiveArtifactGeneration: null, requiresLlmGuidance: null });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toHaveLength(5);
  });

  it("rejects heavy deterministic builds when they do not need LLM guidance", () => {
    expect(assessCloudEligibility({ ...eligible, requiresLlmGuidance: false }).eligible).toBe(false);
  });
});
