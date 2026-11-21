import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AwsBinding } from "./aws-config.js";
import type { AwsExcubitor, AwsSubmit } from "./aws-excubitor.js";
import type { AwsJob } from "./aws-excubitor-schema.js";
import { AwsJournal } from "./aws-journal.js";
import type { AwsRequest } from "./aws-request.js";
import { AwsService } from "./aws-service.js";

const now = Date.parse("2026-11-21T01:00:00Z");
const scope = { repositoryKey: "repo", subsidiaryId: null };
const actor = { sessionId: "work-session", owner: { userId: "owner", organizationId: "org" } };
const permit = async () => {};
const request: AwsRequest = {
  attemptId: "attempt", taskReference: "actio:work", targetId: "runner-host", runner: "build", inputs: { TEST_MODE: "short" },
  deadline: new Date(now + 60_000).toISOString(), evidence: { code: "public", data: "non_confidential", destination: "approved" },
};
const binding: AwsBinding = { repoPath: "repo", subsidiaryId: null, ownerId: "owner", organizationId: "org", targetId: "runner-host",
  runner: "build", destination: "approved", maxSeconds: 300, usageUnitsPerMinute: 1, maxUsageUnits: 3 };
const drive = { folderId: "drive_folder", clientIdEnv: "CLIENT_ID", clientSecretEnv: "CLIENT_SECRET", refreshTokenEnv: "REFRESH_TOKEN",
  sourceRevision: "b".repeat(40), maxArtifactBytes: 1000, expectedNames: ["out.bin"] };
const artifacts = [{ name: "out.bin", bytes: 10, sha256: "a".repeat(64), uri: "https://drive.google.com/open?id=example" }];

function receipt(input: AwsSubmit): AwsJob {
  return { operation_id: "cf00fb85-4ded-40b0-8bcb-99abbcde865d", job_id: input.job_id, target_id: input.target_id, runner: input.runner,
    kind: "fargate", submission: "accepted", release: "pending", provider_state: "RUNNING", containers: [],
    deadline: input.deadline, observed_at: null, stop_requested_at: null, issue: null };
}

function setup(path = ":memory:", driveEnabled = false) {
  const bindings = [binding, { ...binding, targetId: "other-host" }];
  if (driveEnabled) bindings[0] = { ...binding, drive };
  const ex = {
    targets: vi.fn(async () => ({ owner: "excubitor", credentials: { configured: true }, targets: bindings.map(b => ({
      id: b.targetId, name: b.targetId, kind: "fargate" as const, maxRuntimeSeconds: 300,
      runners: [{ id: "build", container: "worker", inputKeys: ["TEST_MODE", "CC_CLOUD_ATTEMPT_ID"] }],
    })) })),
    submit: vi.fn<AwsExcubitor["submit"]>(async input => ({ job: receipt(input) })),
    reconcile: vi.fn<AwsExcubitor["reconcile"]>(async () => undefined),
    observe: vi.fn<AwsExcubitor["observe"]>(async () => { throw new Error("no observation"); }),
    cancel: vi.fn<AwsExcubitor["cancel"]>(async () => { throw new Error("no cancellation"); }),
  };
  const collect = vi.fn(async () => artifacts);
  const ports = { ex, now: () => now, bindings: async () => bindings, authorizeTask: vi.fn(permit), artifactsReady: () => true, collect };
  const journal = new AwsJournal(path);
  return { ex, collect, journal, service: new AwsService(journal, ports), reopen: () => new AwsService(new AwsJournal(path), ports) };
}

describe("AWS cloud work", () => {
  it("lists a proposed start for its session and waits for the bound human's approval", async () => {
    const { service, ex } = setup();
    try {
      await expect(service.propose(scope, actor.sessionId, request)).resolves.toMatchObject({ status: "human_approval_required" });
      await expect(service.status(scope, { sessionId: actor.sessionId }, request.attemptId))
        .resolves.toMatchObject({ status: "human_approval_required" });
      await expect(service.proposals(scope, actor)).resolves.toMatchObject([request]);
      await expect(service.status(scope, { sessionId: "elsewhere" }, request.attemptId)).rejects.toThrow("cloud_attempt_not_found");
      expect(ex.submit).not.toHaveBeenCalled();
      await expect(service.start(scope, actor, request, permit, true)).resolves.toMatchObject({ receipt: { state: "submitted" } });
      await expect(service.proposals(scope, actor)).resolves.toEqual([]);
      expect(ex.submit).toHaveBeenCalledTimes(1);
    } finally { await service.close(); }
  });

  it("checks human identity, allowed destination, deadline, usage and budget before submit", async () => {
    const { service, ex } = setup();
    try {
      await expect(service.start(scope, { ...actor, owner: { ...actor.owner, organizationId: "elsewhere" } }, request, permit))
        .rejects.toThrow("cloud_aws_classification");
      await expect(service.start(scope, actor, { ...request, evidence: { ...request.evidence, destination: "other" } }, permit))
        .rejects.toThrow("cloud_aws_classification");
      await expect(service.start(scope, actor, { ...request, deadline: new Date(now).toISOString() }, permit))
        .rejects.toThrow("cloud_aws_deadline");
      await expect(service.start(scope, actor, { ...request, deadline: new Date(now + 240_000).toISOString() }, permit))
        .rejects.toThrow("cloud_aws_usage");
      await expect(service.start(scope, actor, request, async () => { throw new Error("cloud_budget_exhausted"); }))
        .rejects.toThrow("cloud_budget_exhausted");
      expect(ex.submit).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });

  it("persists the key before submission, permits only one attempt and reserves targets independently", async () => {
    const { service, ex, journal } = setup();
    try {
      ex.submit.mockImplementation(async input => {
        const stored = journal.get(input.job_id.slice(3))?.value;
        expect(stored).toMatchObject({ requestId: input.job_id, targetId: input.target_id });
        expect(stored).not.toHaveProperty("inputs");
        return { job: receipt(input) };
      });
      const starts = await Promise.all([
        service.start(scope, actor, request, permit), service.start(scope, actor, request, permit),
      ]);
      expect(starts.some(run => run.receipt.state === "submitted")).toBe(true);
      expect(ex.submit).toHaveBeenCalledTimes(1);
      await expect(service.start(scope, actor, { ...request, attemptId: "duplicate" }, permit))
        .rejects.toThrow("cloud_aws_duplicate_request");
      await expect(service.start(scope, actor, { ...request, attemptId: "busy", inputs: { TEST_MODE: "long" } }, permit))
        .rejects.toThrow("cloud_aws_busy");
      await expect(service.start(scope, actor, { ...request, attemptId: "parallel", targetId: "other-host" }, permit))
        .resolves.toMatchObject({ receipt: { state: "submitted" } });
      expect(ex.submit).toHaveBeenCalledTimes(2);
    } finally { await service.close(); }
  });

  it("reconciles a lost reply after reopening the journal and distinguishes cancel request from release", async () => {
    const path = mkdtempSync(join(tmpdir(), "cc-aws-"));
    const initial = setup(join(path, "runs.sqlite"));
    const reopened = initial.reopen();
    try {
      initial.ex.submit.mockRejectedValueOnce(new Error("connection lost"));
      const unknown = await initial.service.start(scope, actor, request, permit);
      expect(unknown.receipt.state).toBe("submission_unknown");
      await initial.service.close();
      const job = receipt(initial.ex.submit.mock.calls[0]![0]);
      initial.ex.reconcile.mockResolvedValue(job);
      initial.ex.observe.mockResolvedValue(job);
      const matched = await reopened.status(scope, actor, request.attemptId);
      expect(matched).toMatchObject({ receipt: { operationId: job.operation_id, requestId: job.job_id } });
      expect(initial.ex.reconcile).toHaveBeenCalledWith(expect.objectContaining({ requestId: job.job_id }));
      initial.ex.cancel.mockResolvedValue({ ...job, release: "requested", stop_requested_at: new Date(now).toISOString() });
      await expect(reopened.stop(scope, actor, request.attemptId)).resolves.toMatchObject({ stopProgress: "requested", resourceRelease: "unknown" });
      initial.ex.observe.mockResolvedValue({ ...job, release: "confirmed", provider_state: "STOPPED",
        stop_requested_at: new Date(now).toISOString(), containers: [{ name: "worker", exit_code: 137 }] });
      await expect(reopened.status(scope, actor, request.attemptId))
        .resolves.toMatchObject({ stopProgress: "confirmed", resourceRelease: "released", exitCode: 137 });
      expect(initial.ex.submit).toHaveBeenCalledTimes(1);
    } finally {
      await initial.service.close();
      await reopened.close();
      rmSync(join(path, "runs.sqlite"), { force: true });
      rmdirSync(path);
    }
  });

  it("collects references independently from provider state and quality", async () => {
    const { service, ex, collect } = setup(":memory:", true);
    try {
      const started = await service.start(scope, actor, request, permit);
      const input = ex.submit.mock.calls[0]![0];
      expect(input.inputs).toMatchObject({ CC_CLOUD_ATTEMPT_ID: started.receipt.requestId });
      const job = receipt(input);
      ex.observe.mockResolvedValue({ ...job, release: "confirmed", provider_state: "STOPPED", containers: [{ name: "worker", exit_code: 0 }] });
      await expect(service.collect(scope, actor, request.attemptId))
        .resolves.toMatchObject({ providerTerminal: "succeeded", artifactVerification: artifacts, qualityAcceptance: "pending" });
      await expect(service.quality(scope, actor, request.attemptId, "accepted")).resolves.toMatchObject({ qualityAcceptance: "accepted" });
      expect(collect).toHaveBeenCalledTimes(1);
    } finally { await service.close(); }
  });
});
