import { assessCloudEligibility, type CloudEligibilityEvidence } from "./eligibility.js";

export type CloudProvider = "codex-cloud" | "claude-cloud";

/** No access URLs, tokens, or mutable local paths belong in this persisted record. */
export interface CloudSubmission {
  attemptId: string;
  taskReference: string;
  provider: CloudProvider;
  environmentId: string;
  sourceRevision: string;
  instruction: string;
  eligibility: CloudEligibilityEvidence;
  standardHosted: boolean;
  gpuRequired: boolean;
  gpuVerified: boolean;
  sourceAvailable: boolean;
  artifactTransferReady: boolean;
}

export type CloudReceipt =
  | { state: "submitted"; remoteId: string }
  | { state: "submission_unknown" };

export interface CloudSubmissionStore {
  /** Durable atomic insert-if-absent. A prior intent, including unknown, returns false. */
  reserve(request: CloudSubmission): Promise<boolean>;
  recordReceipt(attemptId: string, receipt: CloudReceipt): Promise<void>;
}

export interface CloudSubmitter {
  readonly provider: CloudProvider;
  submit(request: CloudSubmission): Promise<CloudReceipt>;
}

/** @implements CC-CLOUD-01 CC-CLOUD-02 CC-CLOUD-03 CC-CLOUD-07 CC-CLOUD-09 */
export async function submitCloudWork(
  request: CloudSubmission,
  store: CloudSubmissionStore,
  adapter: CloudSubmitter,
): Promise<CloudReceipt | { state: "already_reserved" }> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(request.attemptId)
    || !/^actio:[a-zA-Z0-9-]+$/.test(request.taskReference)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.sourceRevision)
    || !request.environmentId.trim() || !request.instruction.trim()) {
    throw new Error("invalid_cloud_submission");
  }
  if (adapter.provider !== request.provider) throw new Error("cloud_provider_mismatch");
  if (!request.standardHosted) throw new Error("standard_hosted_required");
  if (!assessCloudEligibility(request.eligibility).eligible) throw new Error("cloud_work_ineligible");
  if (request.gpuRequired && !request.gpuVerified) throw new Error("cloud_gpu_unverified");
  if (!request.sourceAvailable) throw new Error("cloud_source_unavailable");
  if (!request.artifactTransferReady) throw new Error("cloud_artifact_transfer_unready");

  // A crash at any later point leaves an intent. Reconciliation must not re-submit it.
  if (!await store.reserve(request)) return { state: "already_reserved" };
  let receipt: CloudReceipt;
  try {
    receipt = await adapter.submit(request);
  } catch {
    // Transport exceptions may occur after provider acceptance; never persist raw
    // provider errors (which can contain credentials), or infer permission to retry.
    receipt = { state: "submission_unknown" };
  }
  await store.recordReceipt(request.attemptId, receipt);
  return receipt;
}
