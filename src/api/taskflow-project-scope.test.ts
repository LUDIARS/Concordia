/** @implements spec/feature/task-workflow-v3.md CC-AT-SCOPE-01 */
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import { createActioBindingReader } from "../taskflow/actio-project-binding.js";
import { ActioTaskStore } from "../taskflow/actio-store.js";
import { ACTIO_WORKFLOW_SOURCE, type ActioWorkflowClient, type ActioWorkflowTask } from "../taskflow/actio-task-client.js";
import { TaskflowStateStore } from "../taskflow/state-store.js";
import { taskflowRouter } from "./taskflow.js";

function fixture() {
  const read = createActioBindingReader({
    configured: () => [],
    repositories: () => [
      { code: "Other", project: "Other", repo_path: "E:/Other" },
      { code: "Tp", project: "Terpsichore", repo_path: "E:/Terpsichore" },
    ],
    registered: async () => [
      { code: "Other", name: "Other", teamIds: ["a", "b"] },
      { code: "Tp", name: "Terpsichore", teamIds: ["musa"] },
    ],
  });
  const list = vi.fn(async (binding: ActioBinding): Promise<ActioWorkflowTask[]> => [{
    id: "confirmation", title: "Human acceptance", description: "Pending human decision",
    projectId: binding.projectId, ownerId: binding.ownerId, teamId: binding.teamId,
    status: "open", source: ACTIO_WORKFLOW_SOURCE, sourceRef: "confirm-pr",
    pluginId: ACTIO_WORKFLOW_SOURCE, pluginPayload: { version: 3 }, createdAt: "2026-09-27T00:00:00Z",
  }]);
  const state = new TaskflowStateStore(makeTestDb());
  const store = new ActioTaskStore(read, { list } as unknown as ActioWorkflowClient, state);
  const app = taskflowRouter({
    store, state, sessions: { listSessions: () => [] },
    delegation: { recentRuns: () => [] }, prs: { list: () => [] },
  } as unknown as Parameters<typeof taskflowRouter>[0]);
  return { app, list };
}

describe.each(["/tasks", "/overview"])("project-scoped %s", (path) => {
  it("returns the selected team's existing pending task despite unrelated ambiguity", async () => {
    const { app, list } = fixture();
    const response = await app.request(`${path}?project=%20TERPSICHORE%20&head_office=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ tasks: [{
      path: "actio:confirmation", project: "Terpsichore", status: "pending", subsidiary_id: null,
    }] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]![0]).toMatchObject({ projectId: "Tp", teamId: "musa", ownerId: "actio-local" });
  });

  it.each(["?project=Other", ""])("rejects selected or unscoped ambiguity before task I/O: %s", async (query) => {
    const { app, list } = fixture();
    const response = await app.request(path + query);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "actio_project_ambiguous" });
    expect(list).not.toHaveBeenCalled();
  });

  it("returns no tasks for an unknown project without reading another project's tasks", async () => {
    const { app, list } = fixture();
    const response = await app.request(`${path}?project=missing`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tasks: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["status=done", "subsidiary_id=sub-1"])("preserves the existing filter: %s", async (query) => {
    const { app } = fixture();
    const response = await app.request(`${path}?project=Terpsichore&${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tasks: [] });
  });
});
