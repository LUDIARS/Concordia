import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColabAdapter } from "./colab-adapter.js";
import { ColabJournal } from "./colab-journal.js";
import { ColabService } from "./colab-service.js";
import type { ColabStart } from "./colab-run.js";
import type { ColabRest } from "./colab-rest.js";
import type { ColabJupyter } from "./colab-jupyter.js";
import { CloudEnvironmentSchema } from "./runtime-config.js";
import { colabAdmission } from "./colab-policy.js";

const owner = { userId: "user-1", organizationId: "org-1" };
const scope = { repositoryKey: "repo-1", subsidiaryId: null };
const revision = "a".repeat(40);
const requestId = "cfa5a73e-eb5c-46e4-b98b-67442e6515a3";
const name = `runtimes/cc-${requestId}`;
const operationName = "operations/colab-1";
const target = CloudEnvironmentSchema.parse({ id: "colab-1", label: "Colab test", repoPath: "fixture-repo",
  subsidiaryId: null, provider: "colab", environmentId: "colab-1", sourceRevision: revision,
  standardHosted: true, publishedBranch: "main", environmentPreparable: true, requiresLargeProjectClone: false,
  transferMode: "jupyter", colab: {
    ownerId: owner.userId, organizationId: owner.organizationId, credentialRef: "test-oauth", destination: "owner-space",
    code: "public", data: "non_confidential", program: "tests/trial.py", programSha256: "b".repeat(64),
    runtimeSpec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" },
    maxSeconds: 120, maxUsageUnits: 1, usageUnitsPerMinute: 1,
  } });
const input: ColabStart = { attemptId: "attempt-1", taskReference: "actio:task-1", targetId: target.id,
  seconds: 30, ownerApproved: true, evidence: { code: "public", data: "non_confidential", destination: "owner-space" } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cc-colab-test-"));
  const journal = new ColabJournal(dir);
  const runtime = { name, runtimeSpec: target.colab?.runtimeSpec, connectionInfo: { url: "https://runtime.prod.colab.dev", token: "test-only",
    expireTime: "2099-01-01T00:00:00Z" } };
  let exists = true;
  const rest = {
    create: vi.fn<ColabRest["create"]>().mockResolvedValue({ name: operationName, done: false }),
    operation: vi.fn<ColabRest["operation"]>().mockResolvedValue({ name: operationName, done: true, response: runtime }),
    get: vi.fn<ColabRest["get"]>().mockImplementation(async () => exists ? runtime : null),
    delete: vi.fn<ColabRest["delete"]>().mockImplementation(async () => { exists = false; }),
    list: vi.fn<ColabRest["list"]>().mockResolvedValue([name]),
  };
  const jupyter = {
    execute: vi.fn<ColabJupyter["execute"]>().mockResolvedValue("succeeded"),
    readResult: vi.fn<ColabJupyter["readResult"]>().mockResolvedValue(Buffer.from(JSON.stringify({
      version: 1, attemptId: input.attemptId, sourceRevision: revision, exitCode: 0, tests: { total: 3, failed: 0, skipped: 0 },
    }))),
  };
  const ports: ConstructorParameters<typeof ColabService>[1] = {
    targets: async () => [target], authorizeTask: async () => undefined, bindingReady: () => true,
    readProgram: async () => "registered_code()", drive: () => undefined, now: Date.now, uuid: () => requestId,
    adapter: (run, allocation, signal) => new ColabAdapter(rest, jupyter, { allocation, attemptId: run.attemptId,
      revision, checkpoints: [] }, signal),
  };
  const service = new ColabService(journal, ports);
  cleanups.push(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, rest, jupyter, runtime, dir, journal, ports };
}

describe("attended Colab execution", () => {
  it("rejects unknown classification, a mismatched destination, another owner and excess estimated usage before allocation", async () => {
    const { service, rest } = await setup();
    expect(colabAdmission({ ownerApproved: false, evidence: input.evidence, ownerDestination: "owner-space" })).toBe(false);
    await expect(service.start(scope, owner, { ...input, evidence: { ...input.evidence, code: "unknown" } })).rejects.toThrow(/classification/);
    await expect(service.start(scope, owner, { ...input, evidence: { ...input.evidence, destination: "other" } })).rejects.toThrow(/classification/);
    await expect(service.start(scope, { ...owner, userId: "other" }, input)).rejects.toThrow(/owner/);
    await expect(service.start(scope, owner, { ...input, seconds: 120 })).rejects.toThrow(/usage_limit/);
    expect(rest.create).not.toHaveBeenCalled();
  });

  it("stores the UUID and operation before executing and distinguishes report, integrity, quality and release", async () => {
    const { service, rest, jupyter } = await setup();
    rest.operation.mockImplementationOnce(async () => {
      expect((await service.list(scope, owner))[0].receipt).toMatchObject({ requestId, operationId: operationName });
      return { name: operationName, done: false };
    });
    const first = await service.start(scope, owner, input);
    expect(first.receipt).toEqual({ state: "submission_unknown", requestId });
    const result = await vi.waitFor(async () => {
      const [run] = await service.list(scope, owner);
      expect(run.resourceRelease).toBe("released");
      return run;
    }, { timeout: 4000 });
    expect(rest.create).toHaveBeenCalledExactlyOnceWith(name, requestId, target.colab?.runtimeSpec, expect.any(AbortSignal));
    expect(jupyter.execute.mock.calls[0][1]).toContain("registered_code()");
    expect(rest.delete).toHaveBeenCalledTimes(1);
    expect(rest.get).toHaveBeenLastCalledWith(name, expect.any(AbortSignal));
    expect(result).toMatchObject({ providerTerminal: "succeeded", workerReport: { exitCode: 0 },
      artifactVerification: { checkpoints: [] }, qualityAcceptance: "pending", resourceRelease: "released" });
    expect(await service.quality(scope, owner, input.attemptId, "accepted")).toMatchObject({ qualityAcceptance: "accepted" });
    expect(await service.list(scope, { ...owner, userId: "other" })).toEqual([]);
    await service.start(scope, owner, input);
    await expect(service.start(scope, owner, { ...input, attemptId: "different-id" })).rejects.toThrow("cloud_colab_duplicate_request");
    expect(rest.create).toHaveBeenCalledTimes(1);
  });

  it("reconciles an accepted allocation with a lost response and releases after a failed kernel", async () => {
    const { service, rest, jupyter } = await setup();
    rest.create.mockRejectedValueOnce(new Error("response lost"));
    jupyter.execute.mockResolvedValueOnce("failed");
    jupyter.readResult.mockRejectedValueOnce(new Error("result not written"));
    await service.start(scope, owner, input);
    await vi.waitFor(async () => expect((await service.list(scope, owner))[0]).toMatchObject({
      receipt: { state: "submitted", remoteId: name }, providerTerminal: "failed",
      artifactVerification: null, qualityAcceptance: "pending", resourceRelease: "released",
    }));
    expect(rest.create).toHaveBeenCalledTimes(1);
    expect(rest.delete).toHaveBeenCalledTimes(1);
  });

  it("holds the global slot until an ambiguous release is confirmed and does not replay execution", async () => {
    const { service, rest, jupyter } = await setup();
    rest.delete.mockImplementationOnce(async () => undefined);
    await service.start(scope, owner, input);
    await vi.waitFor(() => expect(rest.delete).toHaveBeenCalledTimes(1));
    await expect(service.start(scope, owner, { ...input, attemptId: "attempt-2" })).rejects.toThrow("cloud_colab_busy");
    expect((await service.list(scope, owner))[0].resourceRelease).toBe("unknown");
    await service.recover();
    expect((await service.list(scope, owner))[0].resourceRelease).toBe("released");
    expect(jupyter.execute).toHaveBeenCalledTimes(1);
    expect(rest.create).toHaveBeenCalledTimes(1);
  });

  it("signals cancellation and confirms release without sending a second kernel command", async () => {
    const { service, rest, jupyter } = await setup();
    jupyter.execute.mockImplementationOnce((_connection, _code, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await service.start(scope, owner, input);
    await vi.waitFor(() => expect(jupyter.execute).toHaveBeenCalledTimes(1));
    await service.stop(scope, owner, input.attemptId);
    await vi.waitFor(async () => expect((await service.list(scope, owner))[0]).toMatchObject({
      providerTerminal: "cancelled", stopReason: "cancelled", resourceRelease: "released",
    }));
    expect(rest.delete).toHaveBeenCalledTimes(1);
  });
});
