import { describe, expect, it, vi } from "vitest";
import { taskflowRouter } from "./taskflow.js";
import type { TaskStore } from "../taskflow/store.js";
import type { TaskDocument, TaskStatus } from "../taskflow/types.js";

describe("taskflow HTTP failure boundary", () => {
  it.each([
    ["Actio task project binding missing or ambiguous", 503, "actio_binding_invalid"],
    ["Actio read timed out", 503, "actio_read_timeout"],
    ["Actio read connection failed", 503, "actio_unreachable"],
    ["Actio task team access mismatch", 403, "actio_scope_denied"],
    ["Actio project team registration is ambiguous", 503, "actio_project_ambiguous"],
    ["Actio task request identity reused with different content", 409, "task_identity_conflict"],
    ["SQL failure containing private body secret-token", 500, "taskflow_internal_error"],
  ])("exposes only safe diagnostics for %s", async (message, status, reason) => {
    const input = {
      store: { scan: vi.fn(async () => { throw new Error(message); }) } as unknown as TaskStore,
      state: {}, sessions: {}, delegation: {}, prs: {},
    } as unknown as Parameters<typeof taskflowRouter>[0];
    const app = taskflowRouter(input);
    const response = await app.request("/tasks?project=secret-token");
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ reason });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });
});

describe("taskflow task listing limit", () => {
  it("applies the limit after filtering and validates it before scanning", async () => {
    const task = (id: string, status: TaskStatus): TaskDocument => ({
      path: `actio:${id}`, repoPath: "E:/Concordia", title: id, body: "",
      frontmatter: { task: id, project: "Concordia", kind: "実装", created: "2026-11-26" },
      runtime: { status, subsidiary_id: null, source_session: null, assignee: null, owner: null,
        delegation_run_id: null, pr_number: null, memoria_task_id: null, actio_task_id: id, memoria_registration_state: "idle" },
    });
    const documents = [task("pending", "pending"), task("done-1", "done"), task("done-2", "done")];
    const scan = vi.fn(async () => documents);
    const app = taskflowRouter({
      store: { scan, relativePath: (document: TaskDocument) => document.path },
      state: {}, sessions: {}, delegation: {}, prs: {},
    } as unknown as Parameters<typeof taskflowRouter>[0]);

    expect((await app.request("/tasks?limit=0")).status).toBe(400);
    expect(scan).not.toHaveBeenCalled();
    const response = await app.request("/tasks?status=done&limit=1");
    const { tasks } = await response.json() as { tasks: Array<{ path: string }> };
    expect(tasks.map(({ path }) => path)).toEqual(["actio:done-1"]);
  });
});
