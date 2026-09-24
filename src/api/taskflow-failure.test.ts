import { describe, expect, it, vi } from "vitest";
import { taskflowRouter } from "./taskflow.js";
import type { TaskStore } from "../taskflow/store.js";

describe("taskflow HTTP failure boundary", () => {
  it.each([
    ["Actio task project binding missing or ambiguous", 503, "actio_binding_invalid"],
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
