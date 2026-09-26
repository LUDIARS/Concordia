/** @implements spec/feature/task-workflow-v3.md — CC-TF-SESSION-01 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import { taskflowRouter } from "../api/taskflow.js";
import { ActioTaskStore } from "./actio-store.js";
import { ActioWorkflowClient, ACTIO_WORKFLOW_SOURCE } from "./actio-task-client.js";
import type { ActioTransport } from "./actio-transport.js";
import { TaskflowStateStore } from "./state-store.js";
import { syncTaskSessionAssignment } from "./session-assignment.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { TaskCreateInput } from "./store.js";
import { TaskflowRuntime } from "./runtime.js";
import type { ConfirmIntakeDeps } from "../release/confirm-intake.js";
import { eventBus } from "../events.js";

const REPO = "E:/Document/Ars/Concordia";
const databases: ReturnType<typeof makeTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = makeTestDb(); databases.push(db);
  const sessions = new SessionsRepo(db);
  for (const id of ["issuer", "worker", "successor", "foreign"]) sessions.insertSession({
    id, provider: "claude-code", repo_path: id === "foreign" ? "E:/Document/Ars/Actio" : REPO,
    repo_origin: null, branch: "main", host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
  });
  let task: Record<string, unknown> | null = null;
  const request = vi.fn(async (_binding: unknown, method: string, path: string, body?: Record<string, unknown>) => {
    if (method === "GET" && path.startsWith("/api/tasks?")) return { tasks: task ? [structuredClone(task)] : [] };
    if (method === "POST") task = { id: "t1", createdAt: "2026-09-26T00:00:00Z", ownerId: "local-owner", teamId: null, ...body };
    if (method === "PATCH") task = { ...task, ...body };
    return { task: structuredClone(task) };
  });
  const binding = { repoPath: REPO, project: "Concordia", projectId: "Cc", ownerId: "local-owner", tokenEnv: "TOKEN", teamId: null, subsidiaryId: null };
  const state = new TaskflowStateStore(db);
  const store = new ActioTaskStore(() => [binding], new ActioWorkflowClient({ request } as unknown as ActioTransport), state);
  const delegation = new DelegationRepo(db);
  const app = taskflowRouter({ store, state, sessions, delegation, prs: new PrRecordsRepo(db) });
  const create = (overrides: Partial<TaskCreateInput> = {}) => store.create({
    repoPath: REPO, subsidiaryId: null, sourceRef: "new", title: "task", body: "body", kind: "implementation", memoryLinks: [], ...overrides,
  });
  const patch = (body: Record<string, unknown>) => app.request("/tasks/state", { method: "PATCH",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ repo_path: REPO, task_path: "actio:t1", ...body }) });
  return { db, app, store, state, sessions, delegation, request, create, patch,
    task: () => task!, replace: (value: Record<string, unknown>) => { task = value; } };
}

describe("task session provenance across API and Actio", () => {
  it("records issuer, assigns another worker, hands over and rejects the old worker's release", async () => {
    const f = fixture();
    const res = await f.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      session_id: "issuer", request_id: "6f1d3a2e-0b3c-4f2d-9d5e-8a7c1b2e3f40", title: "task", body: "body",
    }) });
    expect(res.status).toBe(201);
    expect(f.task().pluginPayload).toMatchObject({ issued_by_session_id: "issuer", working_session_id: null });
    expect((await f.patch({ working_session_id: "worker", expected_working_session_id: null })).status).toBe(200);
    expect((await f.patch({ working_session_id: "successor", expected_working_session_id: "worker" })).status).toBe(200);
    expect((await f.patch({ working_session_id: null, expected_working_session_id: "worker" })).status).toBe(409);
    const content = await f.app.request("/tasks/content?session_id=issuer&reference=actio:t1");
    expect(await content.json()).toMatchObject({ issued_by_session_id: "issuer", working_session_id: "successor" });
    expect(f.state.find({ repoPath: REPO, taskPath: "actio:t1" })?.source_session).toBe("successor");
    const overview = await f.app.request("/overview?head_office=1");
    expect((await overview.json()).tasks[0]).toMatchObject({ issued_by_session_id: "issuer", working_session_id: "successor" });
    await f.store.releaseWorkingSession("worker");
    expect(f.task().pluginPayload).toMatchObject({ working_session_id: "successor" });
    await f.store.releaseWorkingSession("successor");
    expect(f.task().pluginPayload).toMatchObject({ issued_by_session_id: "issuer", working_session_id: null });
  });

  it("does not rewrite issuer or worker on a duplicate create, including historical records", async () => {
    const f = fixture();
    await f.create({ issuedBySessionId: "issuer" });
    await f.store.setWorkingSession(REPO, "actio:t1", "worker", null);
    f.store.associate(await f.store.read(REPO, "actio:t1", null), "run1", null);
    expect(f.state.find({ repoPath: REPO, taskPath: "actio:t1" })?.source_session).toBe("worker");
    await f.create({ issuedBySessionId: "successor" });
    expect(f.task().pluginPayload).toMatchObject({ issued_by_session_id: "issuer", working_session_id: "worker" });
    const payload = { version: 3, kind: "implementation", memory_links: [], custom: { keep: true } };
    f.replace({ ...f.task(), pluginPayload: payload });
    await f.create({ issuedBySessionId: "issuer" });
    expect(f.task().pluginPayload).toEqual(payload);
    await f.store.setWorkingSession(REPO, "actio:t1", "worker", null);
    expect(f.task().pluginPayload).toEqual({ ...payload, issued_by_session_id: null, working_session_id: "worker" });
  });

  it("keeps an importer's session out of historical provenance", async () => {
    const f = fixture();
    const response = await f.app.request("/tasks/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      session_id: "issuer", source: "memoria", source_id: "old", status: "pending", title: "old", body: "body",
    }) });
    expect(response.status).toBe(201);
    expect(f.task().pluginPayload).toMatchObject({ issued_by_session_id: null, working_session_id: null });
  });

  it("rejects spoofed issuer, unknown worker, foreign repository and invalid assignment values", async () => {
    const f = fixture(); await f.create();
    for (const body of [{ issued_by_session_id: "issuer" }, { working_session_id: "missing" },
      { working_session_id: "foreign" }, { working_session_id: 42 }, { working_session_id: "worker", source_session: "issuer" }]) {
      expect((await f.patch(body)).status).toBeGreaterThanOrEqual(400);
    }
    expect(f.request.mock.calls.filter(call => call[1] === "PATCH")).toHaveLength(0);
  });

  it("serializes simultaneous handovers and leaves failed remote writes out of the local ledger", async () => {
    const f = fixture(); await f.create();
    const outcomes = await Promise.allSettled([
      f.store.setWorkingSession(REPO, "actio:t1", "worker", null, null),
      f.store.setWorkingSession(REPO, "actio:t1", "successor", null, null),
    ]);
    expect(outcomes.map(x => x.status)).toEqual(["fulfilled", "rejected"]);
    f.request.mockRejectedValueOnce(new Error("Actio task request outcome unknown; reconcile using the same task identity"));
    await expect(f.store.setWorkingSession(REPO, "actio:t1", "successor", null, "worker")).rejects.toThrow("outcome unknown");
    expect(f.state.find({ repoPath: REPO, taskPath: "actio:t1" })?.source_session).toBe("worker");
    await f.store.setWorkingSession(REPO, "actio:t1", "successor", null, "worker");
    expect(f.state.find({ repoPath: REPO, taskPath: "actio:t1" })?.source_session).toBe("successor");
  });

  it("assigns the registered delegation child rather than its issuing parent, and releases on end", async () => {
    const f = fixture(); const task = await f.create({ issuedBySessionId: "issuer" });
    f.store.associate(task, "run1", null);
    const run = { id: "run1", child_session_id: "worker", subsidiary_id: null, spawn_cwd: REPO,
      spawn_worktree_path: null, args_json: JSON.stringify({ taskflow_reference: "actio:t1" }) } as DelegationRunRow;
    vi.spyOn(f.delegation, "findRunByChildSession").mockReturnValue(run);
    await syncTaskSessionAssignment({ ...f, sessionId: "worker", ended: false });
    expect(f.task().pluginPayload).toMatchObject({ issued_by_session_id: "issuer", working_session_id: "worker" });
    await syncTaskSessionAssignment({ ...f, sessionId: "worker", ended: true });
    expect(f.task().pluginPayload).toMatchObject({ working_session_id: null });
    expect(f.task().pluginId).toBe(ACTIO_WORKFLOW_SOURCE);
  });

  it("wires session end events to metadata release and unsubscribes on stop", async () => {
    const f = fixture(); await f.create({ issuedBySessionId: "issuer" });
    await f.store.setWorkingSession(REPO, "actio:t1", "worker", null);
    const release = vi.spyOn(f.store, "releaseWorkingSession");
    const runtime = new TaskflowRuntime({ ...f, prs: new PrRecordsRepo(f.db), confirm: {} as ConfirmIntakeDeps, mentionUserId: () => null });
    const handle = runtime.start();
    try {
      eventBus.emit({ type: "session.ended", session_id: "worker", ts: 123 });
      await vi.waitFor(() => expect(f.task().pluginPayload).toMatchObject({ issued_by_session_id: "issuer", working_session_id: null }));
    } finally { handle.stop(); }
    eventBus.emit({ type: "session.ended", session_id: "worker", ts: 124 });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
