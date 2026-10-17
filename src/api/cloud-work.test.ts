import { describe, expect, it, vi } from "vitest";
import { cloudWorkRouter } from "./cloud-work.js";
import type { CloudWorkRuntime } from "../cloud-work/runtime-service.js";
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
