import { createHash } from "node:crypto";
import type { CloudProvider, CloudReceipt } from "./submission.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:e0ada426 */
import augurContract_8206fac6 from './execution-evidence.contract.js'; /* augur-inject:contract-predicate:8b9f9c7b */

export type ProviderTerminal = "unknown" | "running" | "succeeded" | "failed" | "cancelled";
export type ResourceRelease = "unknown" | "released" | "not_applicable";
export type QualityAcceptance = "pending" | "accepted" | "rejected";
export interface ExecutionIdentity {
  requestFingerprint: string;
  receipt: CloudReceipt;
}

export interface CloudExecutionAdapter<Request, Result> {
  readonly provider: CloudProvider;
  submit(request: Request, save: (receipt: CloudReceipt) => Promise<void>): Promise<CloudReceipt>;
  reconcile(identity: ExecutionIdentity): Promise<CloudReceipt>;
  observe(identity: ExecutionIdentity): Promise<ProviderTerminal>;
  cancel(identity: ExecutionIdentity): Promise<"requested" | "unsupported">;
  collect(identity: ExecutionIdentity): Promise<Result>;
  release(identity: ExecutionIdentity): Promise<ResourceRelease>;
}

export function requestFingerprint(identity: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function executionEvidence<WorkerReport, Verified>(
  receipt: CloudReceipt, observation: ProviderTerminal, verified: Verified, quality: QualityAcceptance,
  release: ResourceRelease, workerReport: WorkerReport,
) {
  return { receipt, providerTerminal: observation, workerReport, artifactVerification: verified,
    qualityAcceptance: quality, resourceRelease: release };
}
// @ts-expect-error augur-inject
executionEvidence = contract(executionEvidence, { ...augurContract_8206fac6, contractId: 'cloud-work-C-4', mode: 'observe', sample: 1, where: 'src/cloud-work/execution-adapter.ts:26', rule: 'contract-wrap', id: '8206fac6' }); /* augur-inject:contract-wrap:8206fac6 */

export function hostedAgentOperations<Result>(input: {
  observe(identity: ExecutionIdentity): Promise<ProviderTerminal>;
  find?(fingerprint: string): Promise<string | undefined>;
  collect?: (identity: ExecutionIdentity) => Promise<Result>;
}): Omit<CloudExecutionAdapter<never, Result>, "provider" | "submit"> {
  return {
    async reconcile(identity) {
      if (identity.receipt.remoteId) return identity.receipt;
      const remoteId = await input.find?.(identity.requestFingerprint);
      // Finding an exact existing task attaches its identity only. The original transport result remains unknown.
      return remoteId ? { state: "submission_unknown", remoteId } : identity.receipt;
    },
    observe: input.observe,
    async cancel() { return "unsupported"; },
    async release() { return "not_applicable"; },
    async collect(identity) {
      if (!input.collect) throw new Error("cloud_artifact_collection_failed");
      return input.collect(identity);
    },
  };
}
