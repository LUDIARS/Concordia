import { describe, expect, it, vi } from "vitest";
import { submitCloudWork, type CloudSubmission, type CloudSubmissionStore, type CloudSubmitter } from "./submission.js";

const request: CloudSubmission = {
  attemptId: "tokyo2070-trial-1", taskReference: "actio:task-1", provider: "codex-cloud",
  environmentId: "test-environment", sourceRevision: "a".repeat(40), instruction: "Model a street terminal",
  eligibility: { repositoryBytes: 480000, environmentPreparable: true, requiresLargeProjectClone: false,
    computeIntensiveArtifactGeneration: true, requiresLlmGuidance: true },
  standardHosted: true, gpuRequired: false, gpuVerified: false, sourceAvailable: true, artifactTransferReady: true,
};

function fixture() {
  const intents = new Set<string>();
  const store: CloudSubmissionStore = {
    reserve: vi.fn(async (r) => { if (intents.has(r.attemptId)) return false; intents.add(r.attemptId); return true; }),
    recordReceipt: vi.fn(async () => {}),
  };
  const adapter: CloudSubmitter = { provider: "codex-cloud", submit: vi.fn<CloudSubmitter["submit"]>(async () => ({ state: "submitted", remoteId: "remote-1" })) };
  return { store, adapter, intents };
}

describe("cloud submission admission and recovery", () => {
  it.each([
    { standardHosted: false }, { sourceAvailable: false }, { artifactTransferReady: false },
    { gpuRequired: true }, { attemptId: "../escape" }, { sourceRevision: "main" },
    { eligibility: { ...request.eligibility, repositoryBytes: 50_000_001 } },
    { eligibility: { ...request.eligibility, environmentPreparable: null } },
  ])("rejects unsafe admission before persistence or provider calls: %j", async (patch) => {
    const { store, adapter } = fixture();
    await expect(submitCloudWork({ ...request, ...patch }, store, adapter)).rejects.toThrow();
    expect(store.reserve).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("persists intent before side effects and admits only one concurrent caller", async () => {
    const { store, adapter, intents } = fixture();
    vi.mocked(adapter.submit).mockImplementation(async () => {
      expect(intents.has(request.attemptId)).toBe(true);
      return { state: "submitted", remoteId: "remote-1" };
    });
    const results = await Promise.all([submitCloudWork(request, store, adapter), submitCloudWork(request, store, adapter)]);
    expect(results).toContainEqual({ state: "already_reserved" });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it("retains ambiguous submission and never retries it", async () => {
    const { store, adapter } = fixture();
    vi.mocked(adapter.submit).mockRejectedValue(new Error("timeout with secret response"));
    await expect(submitCloudWork(request, store, adapter)).resolves.toEqual({ state: "submission_unknown" });
    expect(store.recordReceipt).toHaveBeenCalledWith(request.attemptId, { state: "submission_unknown" });
    await expect(submitCloudWork(request, store, adapter)).resolves.toEqual({ state: "already_reserved" });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it("does not re-submit when receipt persistence fails", async () => {
    const { store, adapter } = fixture();
    vi.mocked(store.recordReceipt).mockRejectedValue(new Error("disk unavailable"));
    await expect(submitCloudWork(request, store, adapter)).rejects.toThrow("disk unavailable");
    await expect(submitCloudWork(request, store, adapter)).resolves.toEqual({ state: "already_reserved" });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch without a durable reservation", async () => {
    const { store, adapter } = fixture();
    vi.mocked(store.reserve).mockRejectedValue(new Error("disk unavailable"));
    await expect(submitCloudWork(request, store, adapter)).rejects.toThrow();
    expect(adapter.submit).not.toHaveBeenCalled();
  });
});
