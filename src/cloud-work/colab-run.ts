import type { ColabClassification } from "./colab-policy.js";
import type { ColabBinding } from "./colab-config.js";
import type { ColabArtifacts, ColabReport } from "./colab-result.js";
import { executionEvidence, type ProviderTerminal, type QualityAcceptance, type ResourceRelease } from "./execution-adapter.js";
import type { CloudReceipt } from "./submission.js";
import type { CloudScope } from "./runtime-service.js";

export interface ColabOwner { userId: string; organizationId: string }
export interface ColabStart {
  attemptId: string;
  taskReference: string;
  targetId: string;
  seconds: number;
  evidence: ColabClassification;
  ownerApproved: boolean;
}
export interface ColabRun {
  key: string;
  requestFingerprint: string;
  scope: CloudScope;
  targetId: string;
  binding: ColabBinding;
  sourceRevision: string;
  taskReference: string;
  attemptId: string;
  requestId: string;
  runtimeName: string;
  createdAt: number;
  deadlineAt: number;
  estimatedUnits: number;
  receipt: CloudReceipt;
  allocation: "unattempted" | "uncertain" | "refused";
  providerTerminal: ProviderTerminal;
  workerReport: ColabReport | null;
  verified: ColabArtifacts | null;
  quality: QualityAcceptance;
  resourceRelease: ResourceRelease;
  stopReason: "cancelled" | "deadline" | "shutdown" | "interrupted" | null;
  error: string | null;
}

export function colabRunStatus(run: ColabRun) {
  return { attemptId: run.attemptId, targetId: run.targetId, taskReference: run.taskReference, provider: "colab" as const,
    createdAt: run.createdAt, deadlineAt: run.deadlineAt, estimatedUnits: run.estimatedUnits, stopReason: run.stopReason, error: run.error,
    ...executionEvidence(run.receipt, run.providerTerminal, run.verified, run.quality, run.resourceRelease, run.workerReport) };
}
