import type { AwsJob } from "./aws-excubitor-schema.js";
import type { ProviderTerminal, ResourceRelease } from "./execution-adapter.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:60bb1bb5 */
import augurContract_604e8b81 from './aws-admission.contract.js'; /* augur-inject:contract-predicate:764be825 */
import augurContract_1645ddb4 from './aws-reconcile.contract.js'; /* augur-inject:contract-predicate:2ff728fa */
import augurContract_44d5b8ce from './aws-evidence.contract.js'; /* augur-inject:contract-predicate:5efcd85b */

export interface AwsAdmission {
  approved: boolean; code: string; data: string; destination: string; expectedDestination: string;
  now: number; deadline: number; maxSeconds: number; unitsPerMinute: number; maxUnits: number;
}

/** @implements CC-CLOUD-AWS C-35 */
export function awsAdmission(input: AwsAdmission): "allowed" | "classification" | "deadline" | "usage" {
  if (!input.approved || input.code !== "public" || input.data !== "non_confidential"
    || input.destination !== input.expectedDestination) return "classification";
  const seconds = (input.deadline - input.now) / 1000;
  if (!(seconds > 0 && seconds <= input.maxSeconds)) return "deadline";
  return seconds / 60 * input.unitsPerMinute <= input.maxUnits ? "allowed" : "usage";
}
// @ts-expect-error augur-inject
awsAdmission = contract(awsAdmission, { ...augurContract_604e8b81, contractId: 'cloud-aws-C-35', mode: 'observe', sample: 1, where: 'src/cloud-work/aws-policy.ts:10', rule: 'contract-wrap', id: '604e8b81' }); /* augur-inject:contract-wrap:604e8b81 */

export interface AwsJobIdentity {
  requestId: string;
  targetId: string;
  runner: string;
}

/** @implements CC-CLOUD-AWS C-36 */
export function matchAwsJob(jobs: readonly AwsJob[], identity: AwsJobIdentity): AwsJob | undefined {
  const matches = jobs.filter(job => job.job_id === identity.requestId);
  const job = matches.length === 1 ? matches[0] : undefined;
  return job?.target_id === identity.targetId && job.runner === identity.runner ? job : undefined;
}
// @ts-expect-error augur-inject
matchAwsJob = contract(matchAwsJob, { ...augurContract_1645ddb4, contractId: 'cloud-aws-C-36', mode: 'observe', sample: 1, where: 'src/cloud-work/aws-policy.ts:25', rule: 'contract-wrap', id: '1645ddb4' }); /* augur-inject:contract-wrap:1645ddb4 */

export interface AwsJobEvidence {
  providerTerminal: ProviderTerminal;
  resourceRelease: ResourceRelease;
  stopProgress: "none" | "requested" | "confirmed";
  exitCode: number | null;
}

/** @implements CC-CLOUD-AWS C-37 */
export function awsJobEvidence(job: AwsJob, container?: string): AwsJobEvidence {
  const released = job.release === "confirmed" || job.release === "not_allocated";
  const stopProgress = job.stop_requested_at ? released ? "confirmed" : "requested" : "none";
  const terminal = job.kind === "fargate" && (job.provider_state === "STOPPED" || job.provider_state === "DELETED");
  const matchingContainers = job.containers.filter(entry => entry.name === container);
  const exitCode = terminal && matchingContainers.length === 1 ? matchingContainers[0]?.exit_code ?? null : null;
  let providerTerminal: ProviderTerminal = "unknown";
  if (exitCode !== null) providerTerminal = exitCode === 0 ? "succeeded" : "failed";
  else if (job.submission === "rejected") providerTerminal = "failed";
  else if (stopProgress === "confirmed") providerTerminal = "cancelled";
  else if (job.provider_state === "running" || job.provider_state === "RUNNING") providerTerminal = "running";
  return { providerTerminal, resourceRelease: released ? "released" : "unknown", stopProgress, exitCode };
}
// @ts-expect-error augur-inject
awsJobEvidence = contract(awsJobEvidence, { ...augurContract_44d5b8ce, contractId: 'cloud-aws-C-37', mode: 'observe', sample: 1, where: 'src/cloud-work/aws-policy.ts:39', rule: 'contract-wrap', id: '44d5b8ce' }); /* augur-inject:contract-wrap:44d5b8ce */
