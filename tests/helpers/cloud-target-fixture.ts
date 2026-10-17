import type { CloudTarget } from "../../src/cloud-work/runtime-config.js";

export function cloudTargetFixture(): CloudTarget {
  return { id: "tokyo-codex", label: "Tokyo test", repoPath: "repo-a", subsidiaryId: null,
    provider: "codex-cloud", environmentId: "test-env", standardHosted: true, publishedBranch: "main",
    sourceRevision: "a".repeat(40), repositoryBytes: 500000, preparationEvidence: "Measured clone and Blender setup verified",
    verifiedAt: "2026-10-16T00:00:00.000Z", environmentPreparable: true, requiresLargeProjectClone: false,
    gpuVerified: false, codexExecutable: "codex.exe", expectedNames: ["scene.blend"], maxArtifactBytes: 1000, transferMode: "s3",
    storage: { bucket: "examplebucket", region: "us-east-1", prefix: "cloud-test", accessKeyEnv: "TEST_ACCESS", secretKeyEnv: "TEST_SECRET" } };
}
