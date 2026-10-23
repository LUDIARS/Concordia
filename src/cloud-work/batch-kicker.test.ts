import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudBatchKicker, type CloudBatchPorts } from "./batch-kicker.js";
import { CloudBatchDefinitionSchema } from "./batch-plan.js";
import type { RemoteTaskStatus } from "./batch-policy.js";
import { FileCloudBatchStore } from "./batch-store.js";
import { CloudWorkRuntime } from "./runtime-service.js";
import type { CloudReceipt } from "./submission.js";
import { cloudTargetFixture } from "../../tests/helpers/cloud-target-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = { repositoryKey: "repo-a", subsidiaryId: null };
const definition = (patch: Record<string, unknown> = {}) => CloudBatchDefinitionSchema.parse({ batchId: "render-1",
  targetId: "tokyo-codex", taskReference: "actio:task-1", instructionTemplate: "Render frame {{frame}}",
  shards: [{ frame: "1" }, { frame: "2" }, { frame: "3" }], computeReason: "CPU render", llmReason: "inspect preview",
  gpuRequired: false, ...patch });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cc-cloud-kicker-")); roots.push(root);
  const target = cloudTargetFixture();
  let next = 0;
  const submit = vi.fn(async (): Promise<CloudReceipt> => ({ state: "submitted", remoteId: `task_${++next}` }));
  const runtime = new CloudWorkRuntime({ root, targets: async () => [target], repositoryKey: async p => p,
    authorizeTask: vi.fn(async () => {}), preflight: vi.fn(async () => {}), adapter: () => ({ provider: "codex-cloud", submit }),
    env: { TEST_ACCESS: "test", TEST_SECRET: "test" }, now: () => Date.parse(target.verifiedAt), collect: vi.fn() });
  const remote = new Map<string, RemoteTaskStatus>();
  const ports: CloudBatchPorts = { store: new FileCloudBatchStore(join(root, "batches")), targets: s => runtime.targets(s),
    authorizeTask: vi.fn(async () => {}), authorizeKick: vi.fn(async () => {}),
    submit: (s, input) => runtime.submit(s, input), journal: (s, id) => runtime.attemptJournal(s, id),
    observe: vi.fn(async (_target, wanted: ReadonlySet<string>) => new Map([...remote].filter(([id]) => wanted.has(id)))),
    now: () => 1000 };
  return { kicker: new CloudBatchKicker(ports), ports, submit, remote, target };
}

describe("Codex Cloud batch kicker", () => {
  it("with the minimum unit of 1, runs shards one at a time and survives restart", async () => {
    const f = await fixture();
    const created = await f.kicker.create(scope, "parent", definition());
    expect(created.concurrency).toBe(1);
    expect(created.shards.map(s => s.phase)).toEqual(["queued", "queued", "queued"]);
    expect(f.submit).not.toHaveBeenCalled();
    const kicked = await f.kicker.tick(scope, "render-1");
    expect(kicked.shards.map(s => s.phase)).toEqual(["running", "queued", "queued"]);
    expect(kicked.shards[0]?.remoteId).toBe("task_1");
    expect(f.submit).toHaveBeenCalledTimes(1);

    f.remote.set("task_1", "pending");
    expect((await f.kicker.tick(scope, "render-1")).counts).toMatchObject({ running: 1, queued: 2 });
    expect(f.submit).toHaveBeenCalledTimes(1);

    f.remote.set("task_1", "ready");
    const restarted = new CloudBatchKicker(f.ports);
    expect((await restarted.tick(scope, "render-1")).shards.map(s => s.phase)).toEqual(["remote_ready", "running", "queued"]);
    expect(f.submit).toHaveBeenCalledTimes(2);
    const observations = vi.mocked(f.ports.observe).mock.calls.length;
    expect((await restarted.status(scope, "render-1")).shards[0]?.phase).toBe("remote_ready");
    expect(f.ports.observe).toHaveBeenCalledTimes(observations);

    f.remote.set("task_2", "error");
    await restarted.tick(scope, "render-1");
    f.remote.set("task_3", "applied");
    const done = await restarted.tick(scope, "render-1");
    expect(done.finished).toBe(true);
    expect(done.counts).toMatchObject({ remote_ready: 2, remote_error: 1 });
    expect(f.submit).toHaveBeenCalledTimes(3);
  });
  it("fills up to the configured concurrency and never beyond", async () => {
    const f = await fixture();
    await f.kicker.create(scope, "parent", definition({ concurrency: 2 }));
    expect((await f.kicker.tick(scope, "render-1")).counts).toMatchObject({ running: 2, queued: 1 });
    await f.kicker.tick(scope, "render-1");
    expect(f.submit).toHaveBeenCalledTimes(2);
  });
  it("keeps an ambiguous submission in its slot and never resubmits it", async () => {
    const f = await fixture();
    f.submit.mockRejectedValueOnce(new Error("socket hang up token=abc"));
    await f.kicker.create(scope, "parent", definition());
    expect((await f.kicker.tick(scope, "render-1")).shards[0]!.phase).toBe("unknown");
    await f.kicker.tick(scope, "render-1");
    await new CloudBatchKicker(f.ports).tick(scope, "render-1");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent ticks to a single submission", async () => {
    const f = await fixture();
    await f.ports.store.create(scope, "parent", definition(), 1);
    await Promise.all([f.kicker.tick(scope, "render-1"), f.kicker.tick(scope, "render-1"), new CloudBatchKicker(f.ports).tick(scope, "render-1")]);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("stop halts new kicks without claiming remote cancellation", async () => {
    const f = await fixture();
    await f.kicker.create(scope, "parent", definition());
    await f.kicker.tick(scope, "render-1");
    const stopped = await f.kicker.stop(scope, "render-1");
    expect(stopped).toMatchObject({ stopped: true, finished: false });
    f.remote.set("task_1", "ready");
    await f.kicker.tick(scope, "render-1");
    await f.kicker.tickAll();
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("holds kicks when the creator's gates deny, reporting only closed errors", async () => {
    const f = await fixture();
    vi.mocked(f.ports.authorizeKick).mockRejectedValue(new Error("cloud_budget_exhausted"));
    await f.kicker.create(scope, "parent", definition());
    expect(await f.kicker.tick(scope, "render-1")).toMatchObject({ lastError: "cloud_budget_exhausted", counts: { queued: 3 } });
    vi.mocked(f.ports.authorizeKick).mockRejectedValue(new Error("cloud_token_secret"));
    expect((await f.kicker.tick(scope, "render-1")).lastError).toBe("cloud_operation_failed");
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("keeps slots occupied when observation fails", async () => {
    const f = await fixture();
    await f.kicker.create(scope, "parent", definition());
    await f.kicker.tick(scope, "render-1");
    vi.mocked(f.ports.observe).mockRejectedValue(new Error("codex_cloud_observation_failed"));
    expect(await f.kicker.tick(scope, "render-1")).toMatchObject({ observation: "failed", counts: { running: 1, queued: 2 } });
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("re-checks stop before launching another shard in the same tick", async () => {
    const f = await fixture();
    await f.kicker.create(scope, "parent", definition({ concurrency: 3 }));
    const submit = f.ports.submit;
    f.ports.submit = async (owner, request) => {
      const result = await submit(owner, request);
      await f.ports.store.stop(scope, "render-1", 1001);
      return result;
    };
    await f.kicker.tick(scope, "render-1");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("rejects non-Codex targets and invalid templates before creating a batch", async () => {
    const f = await fixture();
    f.ports.targets = async () => [{ ...f.target, provider: "claude-cloud", claudeTriggerId: "trig_1", claudeTokenEnv: "TOKEN" }];
    await expect(f.kicker.create(scope, "parent", definition())).rejects.toThrow("cloud_batch_provider_unsupported");
    await expect(f.kicker.create(scope, "parent", definition({ shards: [{ other: "1" }] }))).rejects.toThrow("cloud_batch_variables_mismatch");
    expect(await f.ports.store.list(scope)).toEqual([]);
  });
  it("background sweep kicks every unstopped batch", async () => {
    const f = await fixture();
    await f.ports.store.create(scope, "parent", definition(), 1);
    await f.ports.store.create(scope, "parent", definition({ batchId: "render-2" }), 2);
    await f.kicker.tickAll();
    expect(f.submit).toHaveBeenCalledTimes(2);
  });
});
