import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudWorkRuntime, type CloudRuntimePorts, type CloudWorkInput } from "./runtime-service.js";
import { cloudTargetFixture } from "../../tests/helpers/cloud-target-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = { repositoryKey: "repo-a", subsidiaryId: null };
const input: CloudWorkInput = { attemptId: "attempt-1", targetId: "tokyo-codex", taskReference: "actio:task-1",
  instruction: "Model a terminal", computeReason: "CPU mesh generation and render", llmReason: "Choose shape and inspect preview", gpuRequired: false };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cc-cloud-runtime-")); roots.push(root);
  const target = cloudTargetFixture(), content = Buffer.from("BLENDER-fixture");
  const submit = vi.fn(async () => ({ state: "submitted" as const, remoteId: "task_1" }));
  const ports: CloudRuntimePorts = { root, targets: async () => [target], repositoryKey: async p => p,
    authorizeTask: vi.fn(async () => {}), preflight: vi.fn(async () => {}),
    adapter: () => ({ provider: "codex-cloud", submit }), env: { TEST_ACCESS: "test", TEST_SECRET: "test" },
    now: () => Date.parse(target.verifiedAt), collect: vi.fn(async () => ({
      manifest: { version: 1, status: "completed", attemptId: input.attemptId, sourceRevision: target.sourceRevision,
        artifacts: [{ name: "scene.blend", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }] },
      received: new Map([["scene.blend", content]]),
    })),
  };
  return { runtime: new CloudWorkRuntime(ports), ports, submit, target, content };
}

describe("integrated cloud work runtime", () => {
  it("freezes per-run work and rejects changed work under the same attempt ID", async () => {
    const f = await fixture();
    const { sourceRevision, repositoryBytes, expectedNames, maxArtifactBytes, preparationEvidence, verifiedAt, ...environment } = f.target;
    f.ports.targets = async () => [environment];
    const work = { sourceRevision, repositoryBytes, expectedNames, maxArtifactBytes, preparationEvidence, verifiedAt };
    await f.runtime.submit(scope, { ...input, work });
    await expect(f.runtime.submit(scope, { ...input, work: { ...work, expectedNames: ["different.png"] } })).rejects.toThrow("cloud_attempt_conflict");
    expect(await f.runtime.collect(scope, input.attemptId)).toMatchObject({ state: "artifacts_verified" });
    expect(f.submit).toHaveBeenCalledOnce();
  });
  it("routes Git collection to review without invoking S3 or claiming artifacts accepted", async () => {
    const f = await fixture();
    f.target.transferMode = "git";
    f.target.git = { publicHost: "git.example.com", accessHeaderEnv: "ACCESS", accessHeaderName: "X-Access" };
    f.ports.env.ACCESS = "test";
    f.ports.collectGit = vi.fn(async () => ({ state: "review_submitted", oid: "b".repeat(40) }));
    await f.runtime.submit(scope, input);
    expect(await f.runtime.collect(scope, input.attemptId)).toMatchObject({ state: "review_submitted", transferMode: "git" });
    await f.runtime.collect(scope, input.attemptId);
    expect(f.ports.collectGit).toHaveBeenCalledOnce();
    expect(f.ports.collect).not.toHaveBeenCalled();
    await expect(f.runtime.download(scope, input.attemptId, "scene.blend")).rejects.toThrow();
  });
  it("submits once, survives reconstruction, collects and serves verified bytes", async () => {
    const f = await fixture();
    expect(await f.runtime.submit(scope, input)).toMatchObject({ state: "submitted" });
    const restarted = new CloudWorkRuntime(f.ports);
    expect(await restarted.submit(scope, input)).toMatchObject({ state: "submitted" });
    expect(f.submit).toHaveBeenCalledTimes(1);
    await expect(restarted.download(scope, input.attemptId, "scene.blend")).rejects.toThrow();
    expect(await restarted.collect(scope, input.attemptId)).toMatchObject({ state: "artifacts_verified" });
    expect(await restarted.download(scope, input.attemptId, "scene.blend")).toEqual(f.content);
    expect(await restarted.list(scope)).toHaveLength(1);
    await restarted.collect(scope, input.attemptId);
    expect(f.ports.collect).toHaveBeenCalledTimes(1);
  });
  it("isolates company and repository scopes", async () => {
    const f = await fixture();
    await f.runtime.submit(scope, input);
    for (const wrong of [{ ...scope, repositoryKey: "other" }, { ...scope, subsidiaryId: "other-company" }]) {
      expect(await f.runtime.availability(wrong)).toEqual([]);
      await expect(f.runtime.status(wrong, input.attemptId)).rejects.toThrow();
      await expect(f.runtime.submit(wrong, input)).rejects.toThrow();
    }
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("prevents submission after task authorization or preflight failure", async () => {
    const f = await fixture();
    vi.mocked(f.ports.authorizeTask).mockRejectedValueOnce(new Error("out of scope"));
    await expect(f.runtime.submit(scope, input)).rejects.toThrow();
    vi.mocked(f.ports.preflight).mockRejectedValueOnce(new Error("unpublished"));
    await expect(f.runtime.submit(scope, input)).rejects.toThrow();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("retains unknown receipts and reconciles without resubmitting", async () => {
    const f = await fixture();
    f.submit.mockRejectedValue(new Error("lost response"));
    expect(await f.runtime.submit(scope, input)).toMatchObject({ state: "submission_unknown" });
    expect(await f.runtime.reconcile(scope, input.attemptId, "task_observed")).toMatchObject({
      state: "submission_unknown", reconciliation: { remoteId: "task_observed", source: "operator_observation" } });
    await f.runtime.submit(scope, input);
    expect(f.submit).toHaveBeenCalledTimes(1);
    await expect(f.runtime.submit(scope, { ...input, instruction: "different" })).rejects.toThrow("cloud_attempt_conflict");
  });
  it("never serves corrupt or cross-attempt artifacts", async () => {
    const f = await fixture();
    await f.runtime.submit(scope, input);
    vi.mocked(f.ports.collect).mockResolvedValue({ manifest: { attemptId: "other" }, received: new Map() });
    await expect(f.runtime.collect(scope, input.attemptId)).rejects.toThrow();
    await expect(f.runtime.download(scope, input.attemptId, "scene.blend")).rejects.toThrow();
  });
});
