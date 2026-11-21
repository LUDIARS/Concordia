import type { AwsDriveBinding } from "./aws-config.js";
import type { AwsJob } from "./aws-excubitor-schema.js";
import type { AwsRequest } from "./aws-request.js";
import type { ColabCheckpoint } from "./drive-artifacts.js";
import { executionEvidence, type QualityAcceptance } from "./execution-adapter.js";
import { awsJobEvidence, type AwsJobIdentity } from "./aws-policy.js";
import type { CloudReceipt } from "./submission.js";

export interface AwsOwner { userId: string; organizationId: string }

export interface AwsRun extends AwsJobIdentity {
  key: string;
  scopeKey: string;
  sessionId: string;
  owner: AwsOwner;
  attemptId: string;
  taskReference: string;
  requestFingerprint: string;
  createdAt: number;
  deadline: string;
  container?: string;
  kind: "ec2" | "fargate";
  drive?: AwsDriveBinding;
  job?: AwsJob;
  refusal?: string;
  stopRequested?: boolean;
  issue?: "cloud_aws_observation_unavailable" | "cloud_aws_stop_unconfirmed";
  artifacts?: ColabCheckpoint[];
  quality?: QualityAcceptance;
}

export interface AwsProposal {
  key: string; scopeKey: string; request: AwsRequest; sessionId: string; expiresAt: number;
}

export function awsRunStatus(run: AwsRun) {
  const job = run.job;
  const evidence = job ? awsJobEvidence(job, run.container) : undefined;
  const receipt: CloudReceipt = job
    ? { state: "submitted", operationId: job.operation_id, remoteId: job.operation_id, requestId: run.requestId }
    : { state: run.refusal ? "submission_refused" : "submission_unknown", requestId: run.requestId };
  return {
    provider: "aws" as const,
    attemptId: run.attemptId, taskReference: run.taskReference, targetId: run.targetId, runner: run.runner, kind: run.kind,
    submission: run.refusal ? "refused" : job?.submission ?? "unknown",
    issue: run.refusal ?? run.issue ?? job?.issue ?? null,
    deadline: job?.deadline ?? run.deadline,
    providerState: job?.provider_state ?? null,
    providerObservedAt: job?.observed_at ?? null,
    excubitorRelease: job?.release ?? null,
    exitCode: evidence?.exitCode ?? null,
    stopProgress: evidence?.stopProgress === "confirmed" ? "confirmed" : run.stopRequested ? "requested" : evidence?.stopProgress ?? "none",
    artifactCollectionConfigured: !!run.drive && job?.release === "confirmed",
    ...executionEvidence(receipt, run.refusal ? "failed" : evidence?.providerTerminal ?? "unknown", run.artifacts ?? null,
      run.quality ?? "pending", run.refusal ? "released" : evidence?.resourceRelease ?? "unknown", null),
  };
}
