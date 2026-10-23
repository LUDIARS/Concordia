import { describe, expect, it, vi } from "vitest";
import { cloudWorkRouter } from "./cloud-work.js";
import type { CloudWorkRuntime } from "../cloud-work/runtime-service.js";
import type { CloudBatchKicker } from "../cloud-work/batch-kicker.js";
import type { SessionRow } from "../shared/types.js";

const session: SessionRow = { id: "parent", provider: "codex-cli", repo_path: "repo-a", repo_origin: null,
  branch: "main", host: "test", started_at: 0, ended_at: null, status: "active", last_seen_at: 0,
  current_task: null, transcript_path: null, metadata: JSON.stringify({ subsidiary_id: "company-a" }), ws_clients: 0, target_project: "repo-a" };
function fixture() {
  const runtime = { availability: vi.fn(async () => []), submit: vi.fn(async () => ({ state: "submitted" })),
    list: vi.fn(async () => []), status: vi.fn(async () => ({ state: "submission_unknown" })),
    collect: vi.fn(async () => ({ state: "artifacts_verified" })), reconcile: vi.fn(async () => ({})), download: vi.fn(async () => Buffer.from("BLEND")) };
  const findSession = vi.fn((id: string) => id === session.id ? session : null);
  const app = cloudWorkRouter({ sessions: { findSession }, runtime: runtime as unknown as CloudWorkRuntime, repositoryKey: async p => p });
  return { app, runtime, findSession };
}
const body = { session_id: "parent", attemptId: "attempt-1", targetId: "target-1", taskReference: "actio:task-1",
  instruction: "Model", computeReason: "render", llmReason: "visual judgment", gpuRequired: false };
const post = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

describe("cloud delegation public boundary", () => {
  it("requires a live parent session and forwards canonical company scope", async () => {
    const f = fixture();
    expect((await f.app.request("/targets")).status).toBe(403);
    expect((await f.app.request("/targets?session_id=parent")).status).toBe(200);
    expect(f.runtime.availability).toHaveBeenCalledWith({ repositoryKey: "repo-a", subsidiaryId: "company-a" });
    f.findSession.mockReturnValue({ ...session, status: "ended" });
    expect((await f.app.request("/runs", post(body))).status).toBe(403);
    expect(f.runtime.submit).not.toHaveBeenCalled();
  });
  it.each([{ executable: "evil" }, { repoPath: "other" }, { storage: { url: "http://internal" } }, { token: "secret" }])("does not accept client-selected execution/storage fields", async patch => {
    const f = fixture();
    expect((await f.app.request("/runs", post({ ...body, ...patch }))).status).toBe(400);
    expect(f.runtime.submit).not.toHaveBeenCalled();
  });
  it("returns accepted separately from completion and uses the same scope for collection", async () => {
    const f = fixture();
    expect((await f.app.request("/runs", post(body))).status).toBe(202);
    expect((await f.app.request("/runs/attempt-1/collect", post({ session_id: "parent" }))).status).toBe(200);
    expect(f.runtime.collect).toHaveBeenCalledWith({ repositoryKey: "repo-a", subsidiaryId: "company-a" }, "attempt-1");
  });
  it("enforces the existing launch budget gate before creating cloud work", async () => {
    const f = fixture();
    const app = cloudWorkRouter({ sessions: { findSession: f.findSession }, runtime: f.runtime as unknown as CloudWorkRuntime,
      repositoryKey: async p => p, authorizeSubmit: async () => { throw new Error("cloud_budget_exhausted"); } });
    const response = await app.request("/runs", post(body));
    expect(await response.json()).toEqual({ error: "cloud_budget_exhausted" });
    expect(f.runtime.submit).not.toHaveBeenCalled();
  });
  it("never returns arbitrary provider exception text", async () => {
    const f = fixture();
    f.runtime.submit.mockRejectedValue(new Error("Bearer secret https://signed-url"));
    const response = await f.app.request("/runs", post(body));
    expect(await response.json()).toEqual({ error: "cloud_operation_failed" });
  });
  it("downloads only through the scoped verified-artifact boundary", async () => {
    const f = fixture();
    const response = await f.app.request("/runs/attempt-1/artifacts/scene.blend?session_id=parent");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="scene.blend"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.runtime.download).toHaveBeenCalledWith({ repositoryKey: "repo-a", subsidiaryId: "company-a" }, "attempt-1", "scene.blend");
  });
});

describe("cloud batch public boundary", () => {
  const batchBody = { session_id: "parent", batchId: "render-1", targetId: "target-1", taskReference: "actio:task-1",
    instructionTemplate: "Render {{frame}}", shards: [{ frame: "1" }], computeReason: "render", llmReason: "visual judgment", gpuRequired: false };
  function batchFixture(withBatches = true) {
    const batches = { create: vi.fn(async () => ({ batchId: "render-1" })), list: vi.fn(async () => []),
      status: vi.fn(async () => ({ batchId: "render-1" })), stop: vi.fn(async () => ({ stopped: true })),
      startTick: vi.fn(), tick: vi.fn(async () => ({})) };
    const authorizeSubmit = vi.fn(async () => {});
    const app = cloudWorkRouter({ sessions: { findSession: (id: string) => id === session.id ? session : null },
      runtime: {} as CloudWorkRuntime, repositoryKey: async p => p, authorizeSubmit,
      ...(withBatches ? { batches: batches as unknown as CloudBatchKicker } : {}) });
    return { app, batches, authorizeSubmit };
  }
  const owner = { repositoryKey: "repo-a", subsidiaryId: "company-a" };
  it("creates through the submit gates with the live session's scope", async () => {
    const f = batchFixture();
    expect((await f.app.request("/batches", post(batchBody))).status).toBe(202);
    expect(f.authorizeSubmit).toHaveBeenCalledWith("parent", owner);
    expect(f.batches.create).toHaveBeenCalledWith(owner, "parent", expect.objectContaining({ batchId: "render-1", concurrency: 1 }));
  });
  it.each([{ executable: "evil" }, { concurrency: 11 }, { attemptId: "x" }])("rejects client-selected execution fields and bounds", async patch => {
    const f = batchFixture();
    expect((await f.app.request("/batches", post({ ...batchBody, ...patch }))).status).toBe(400);
    expect(f.batches.create).not.toHaveBeenCalled();
  });
  it("accepts a batch body larger than a single run body", async () => {
    const f = batchFixture();
    const shards = Array.from({ length: 100 }, (_, i) => ({ frame: `${i}`.padEnd(400, "x") }));
    expect((await f.app.request("/batches", post({ ...batchBody, shards }))).status).toBe(202);
  });
  it("gates stop and tick by live session; only tick re-checks submit gates", async () => {
    const f = batchFixture();
    expect((await f.app.request("/batches/render-1/stop", post({ session_id: "parent" }))).status).toBe(200);
    expect(f.authorizeSubmit).not.toHaveBeenCalled();
    expect((await f.app.request("/batches/render-1/tick", post({ session_id: "parent" }))).status).toBe(202);
    expect(f.authorizeSubmit).toHaveBeenCalledOnce();
    expect(f.batches.startTick).toHaveBeenCalledWith(owner, "render-1");
    expect((await f.app.request("/batches/render-1/tick", post({ session_id: "nobody" }))).status).toBe(403);
    expect((await f.app.request("/batches/render-1?session_id=parent")).status).toBe(200);
    expect(f.batches.status).toHaveBeenCalledWith(owner, "render-1");
  });
  it("maps kicker errors to the closed vocabulary and reports absence explicitly", async () => {
    const f = batchFixture();
    f.batches.create.mockRejectedValueOnce(new Error("cloud_batch_conflict"));
    const response = await f.app.request("/batches", post(batchBody));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "cloud_batch_conflict" });
    expect((await batchFixture(false).app.request("/batches?session_id=parent")).status).toBe(503);
  });
  it("bounds batch listing work", async () => {
    const f = batchFixture();
    expect((await f.app.request("/batches?session_id=parent&limit=50")).status).toBe(200);
    expect(f.batches.list).toHaveBeenCalledWith(owner, 50);
    expect((await f.app.request("/batches?session_id=parent&limit=51")).status).toBe(400);
  });
});
