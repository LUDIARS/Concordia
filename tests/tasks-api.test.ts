/** @implements spec/feature/cc-task-fallback.md */
import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

describe("/v1/tasks", () => {
  it("persists a task and makes source_key creation idempotent", async () => {
    const env = makeTestApp();
    const first = await env.app.request("/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_key: "request-1", title: "Actio 復旧待ち", status: "todo" }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { created: boolean; task: { id: string; status: string } };
    expect(firstBody).toMatchObject({ created: true, task: { status: "open" } });

    const repeated = await env.app.request("/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_key: "request-1", title: "duplicate" }),
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      created: false,
      task: { id: firstBody.task.id, title: "Actio 復旧待ち" },
    });
  });

  it("validates source_key and rejects an empty patch", async () => {
    const env = makeTestApp();
    const invalidCreate = await env.app.request("/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_key: 42, title: "invalid" }),
    });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toEqual({ error: "invalid_source_key" });

    for (const body of [42, [], { source_key: "   ", title: "invalid" }]) {
      const invalidBody = await env.app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(invalidBody.status).toBe(400);
    }

    const created = await env.app.request("/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "keep" }),
    });
    const { task } = await created.json() as { task: { id: string } };
    const emptyPatch = await env.app.request(`/v1/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);
    expect(await emptyPatch.json()).toEqual({ error: "empty_patch" });
  });

  it("patches, fetches, and filters locally persisted tasks", async () => {
    const env = makeTestApp();
    const created = await env.app.request("/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "ship it", status: "doing" }),
    });
    const { task } = await created.json() as { task: { id: string; status: string } };
    expect(task.status).toBe("in_progress");

    const patched = await env.app.request(`/v1/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done", details: "finished" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ task: { status: "done", details: "finished" } });

    const fetched = await env.app.request(`/v1/tasks/${task.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ task: { id: task.id, status: "done" } });

    const listed = await env.app.request("/v1/tasks?status=done");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ tasks: [{ id: task.id, status: "done" }] });
  });

  it("is disabled with the task workflow", async () => {
    const env = makeTestApp();
    env.adminState.setWorkflowEnabled("task", false);
    const response = await env.app.request("/v1/tasks");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workflow_disabled", workflow: "task" });
  });
});
