import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColabJournal } from "./colab-journal.js";
import { ColabService } from "./colab-service.js";
import type { ColabStart } from "./colab-run.js";
import type { ColabSiteTransport } from "./colab-site-excubitor.js";
import type { SiteReceipt } from "./colab-site-schema.js";
import { CloudEnvironmentSchema } from "./runtime-config.js";

const scope = { repositoryKey: "example", subsidiaryId: null };
const owner = { userId: "owner", organizationId: "org" };
const revision = "a".repeat(40);
const requestId = "213aec5e-4325-414b-844b-5890cb5a965b";
const jobId = "843f4c3c-c4f2-4465-95f0-e8398ed7f824";
const now = 1_800_000_000_000;
const deadlineAt = now + 30_000;
const rawTarget = { id: "colab", label: "Site GPU", provider: "colab", repoPath: "repo", subsidiaryId: null,
  environmentId: "colab", sourceRevision: revision, publishedBranch: "main", standardHosted: true,
  environmentPreparable: true, requiresLargeProjectClone: false,
  colab: { ownerId: owner.userId, organizationId: owner.organizationId, destination: "owner-space",
    programSha256: "b".repeat(64), code: "public", data: "non_confidential",
    site: { peerId: "gromac", programId: "checks", gpu: "T4", outputNames: ["checks.bin"] },
    maxSeconds: 60, maxUsageUnits: 1, usageUnitsPerMinute: 1 } };
const target = CloudEnvironmentSchema.parse(rawTarget);
const input: ColabStart = { attemptId: "attempt-1", taskReference: "actio:task-1", targetId: target.id,
  seconds: 30, ownerApproved: true, evidence: { code: "public", data: "non_confidential", destination: "owner-space" } };
const receipt: SiteReceipt = { id: jobId, programId: "checks", sourceRevision: revision, gpu: "T4", phase: "accepted",
  outcome: null, stopReason: null, createdAt: now, deadlineAt, files: [], events: [] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cc-colab-site-"));
  const journal = new ColabJournal(dir);
  const site = {
    readiness: vi.fn<ColabSiteTransport["readiness"]>().mockResolvedValue(null),
    submit: vi.fn<ColabSiteTransport["submit"]>().mockResolvedValue({ receipt }),
    observe: vi.fn<ColabSiteTransport["observe"]>().mockResolvedValue(receipt),
    cancel: vi.fn<ColabSiteTransport["cancel"]>().mockResolvedValue(receipt),
    manifest: vi.fn<ColabSiteTransport["manifest"]>(), file: vi.fn<ColabSiteTransport["file"]>(),
  };
  const ports = {
    targets: async () => [target], authorizeTask: async () => undefined, bindingReady: () => true,
    readProgram: vi.fn(async () => { throw new Error("legacy Git read"); }),
    adapter: vi.fn(() => { throw new Error("legacy Colab adapter"); }),
    site, drive: () => undefined, now: () => now, uuid: () => requestId,
  };
  const service = new ColabService(journal, ports);
  cleanups.push(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const status = async () => (await service.list(scope, owner))[0];
  return { service, site, ports, status };
}

function artifact(name: string, bytes: Buffer) {
  return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("Colab site execution", () => {
  it("defaults Colab to the site, requires explicit legacy selection, and reports read-only connection readiness", async () => {
    const { service, site, ports } = await setup();
    expect(target.transferMode).toBe("excubitor-site");
    expect(CloudEnvironmentSchema.safeParse({ ...rawTarget, transferMode: "jupyter" }).success).toBe(false);
    site.readiness.mockResolvedValueOnce("cloud_colab_site_mesh_not_ready");
    await expect(service.targets(scope, owner)).resolves.toMatchObject([{ ready: false, reason: "cloud_colab_site_mesh_not_ready" }]);
    await expect(service.targets(scope, owner)).resolves.toMatchObject([{ ready: true }]);
    await expect(service.targets(scope, { ...owner, userId: "other" })).resolves.toEqual([]);
    site.readiness.mockResolvedValueOnce("cloud_colab_site_mesh_not_ready");
    await expect(service.start(scope, owner, input)).rejects.toThrow("cloud_colab_site_mesh_not_ready");
    await expect(service.list(scope, owner)).resolves.toEqual([]);
    expect(site.submit).not.toHaveBeenCalled();
    expect(ports.adapter).not.toHaveBeenCalled();
  });

  it("persists the idempotency key before the only submission and holds the slot if the receipt is lost", async () => {
    const { service, site, ports, status } = await setup();
    site.submit.mockImplementationOnce(async (_peer, request) => {
      expect(await status()).toMatchObject({ receipt: { requestId: request.idempotencyKey, state: "submission_unknown" } });
      expect(request).toEqual({ idempotencyKey: requestId, ownerId: owner.userId, ownerStart: true, programId: "checks",
        sourceRevision: revision, programSha256: "b".repeat(64), gpu: "T4", deadlineAt, code: "public", data: "non_confidential" });
      throw new Error("lost response");
    });
    await service.start(scope, owner, input);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ error: "cloud_colab_site_submission_unknown" }));
    await service.recover();
    await service.start(scope, owner, input);
    await expect(service.start(scope, owner, { ...input, attemptId: "attempt-2", seconds: 31 })).rejects.toThrow("cloud_colab_busy");
    expect(site.submit).toHaveBeenCalledExactlyOnceWith("gromac", expect.objectContaining({ idempotencyKey: requestId }));
    expect(site.observe).not.toHaveBeenCalled();
    expect(ports.readProgram).not.toHaveBeenCalled();
  });

  it("keeps requested stop and ambiguous release separate, then confirms release from the same remote job", async () => {
    const { service, site, status } = await setup();
    await service.start(scope, owner, input);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ receipt: { remoteId: jobId } }));
    const stopped = { ...receipt, outcome: "cancelled", stopReason: "cancelled" } as const;
    site.cancel.mockResolvedValueOnce({ ...stopped, phase: "release_unknown" });
    await expect(service.stop(scope, owner, input.attemptId)).resolves.toMatchObject({ stopProgress: "requested" });
    await vi.waitFor(async () => expect(await status()).toMatchObject({ sitePhase: "release_unknown", resourceRelease: "unknown", stopProgress: "requested" }));
    await expect(service.start(scope, owner, { ...input, attemptId: "another", seconds: 31 })).rejects.toThrow("cloud_colab_busy");
    site.observe.mockResolvedValueOnce({ ...stopped, phase: "released" });
    await service.recover();
    expect(await status()).toMatchObject({ providerTerminal: "cancelled", resourceRelease: "released", stopProgress: "confirmed" });
    expect(site.cancel).toHaveBeenCalledExactlyOnceWith("gromac", jobId);
    expect(site.observe).toHaveBeenCalledExactlyOnceWith("gromac", jobId);
  });

  it("verifies the report and rejects changed bytes without accepting the artifact", async () => {
    const { service, site, status } = await setup();
    const checkpoint = Buffer.from("expected");
    const output = artifact("checks.bin", checkpoint);
    const report = Buffer.from(JSON.stringify({ version: 1, attemptId: requestId, sourceRevision: revision, exitCode: 0,
      tests: { total: 1, failed: 0, skipped: 0 }, checkpoints: [output] }));
    const result = artifact("cc-result.json", report);
    const files = [result, output];
    site.submit.mockResolvedValueOnce({ receipt: { ...receipt, phase: "released", outcome: "completed", files } });
    site.manifest.mockResolvedValue(files);
    let valid = false;
    site.file.mockImplementation(async (_peer, _id, name) => {
      const file = name === result.name ? result : output;
      const bytes = name === result.name ? report : valid ? checkpoint : Buffer.from("modified");
      return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/octet-stream",
        "content-length": String(file.bytes), "x-artifact-sha256": file.sha256 } });
    });
    await service.start(scope, owner, input);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ sitePhase: "released", canCollectSite: true }));
    await expect(service.collect(scope, owner, input.attemptId)).rejects.toThrow("cloud_artifact_integrity_failed");
    expect(await status()).toMatchObject({ workerReport: { exitCode: 0 }, artifactVerification: null, qualityAcceptance: "pending" });
    valid = true;
    await expect(service.collect(scope, owner, input.attemptId)).resolves.toMatchObject({
      artifactVerification: { siteFiles: [output], checkpoints: [] }, qualityAcceptance: "pending", resourceRelease: "released" });
  });
});
