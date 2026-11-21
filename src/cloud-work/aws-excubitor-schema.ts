import { z } from "zod";
import { AwsId, AwsInputKey } from "./aws-request.js";

const Kind = z.enum(["ec2", "fargate"]);
const Timestamp = z.string().datetime({ offset: true }).nullable();
export const AwsTargetSchema = z.object({
  id: AwsId,
  name: z.string().min(1).max(100),
  kind: Kind,
  maxRuntimeSeconds: z.number().int().min(60).max(604800),
  runners: z.array(z.object({
    id: AwsId, inputKeys: z.array(AwsInputKey).max(16),
    container: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).optional(),
  })).min(1).max(12),
});
export const AwsTargetList = z.object({
  targets: z.array(AwsTargetSchema),
  credentials: z.object({ configured: z.boolean() }),
  owner: z.string().min(1).max(200),
});
export type AwsTarget = z.infer<typeof AwsTargetSchema>;

export const AwsJobSchema = z.object({
  operation_id: z.string().uuid(),
  job_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  target_id: AwsId,
  runner: AwsId,
  kind: Kind,
  submission: z.enum(["queued", "submitting", "unknown", "accepted", "rejected", "discarded"]),
  release: z.enum(["pending", "requested", "confirmed", "not_allocated"]),
  provider_state: z.enum(["pending", "running", "shutting-down", "terminated", "stopping", "stopped",
    "PROVISIONING", "PENDING", "ACTIVATING", "RUNNING", "DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED", "DELETED"]).nullable(),
  containers: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/), exit_code: z.number().int().nullable() })).max(100),
  deadline: z.string().datetime({ offset: true }),
  observed_at: Timestamp,
  stop_requested_at: Timestamp,
  issue: z.enum(["credentials_unavailable", "deadline_elapsed", "cancelled_before_submit", "launch_rejected",
    "launch_unconfirmed", "resource_not_visible", "resource_mismatch", "observation_failed", "release_failed",
    "invalid_runner_configuration"]).nullable(),
});
export type AwsJob = z.infer<typeof AwsJobSchema>;
export const AwsJobPage = z.object({ jobs: z.array(AwsJobSchema).max(100) });
export const AwsRefusal = z.object({
  error: z.enum(["launch_disabled", "invalid_job", "credentials_unavailable", "runner_not_found",
    "target_not_found", "target_busy", "invalid_inputs", "deadline_elapsed"]),
});
