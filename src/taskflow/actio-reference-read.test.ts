/** @implements CC-TASK-LINKED-FOLLOWUP — 参照専用の読み込み (client.getReference / store.readReference) */

import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { ActioBinding } from "./actio-binding.js";
import { ActioTaskStore } from "./actio-store.js";
import { ACTIO_WORKFLOW_SOURCE, ActioWorkflowClient, type ActioWorkflowTask } from "./actio-task-client.js";
import type { ActioTransport } from "./actio-transport.js";
import { TaskflowStateStore } from "./state-store.js";

const BINDING: ActioBinding = {
  repoPath: "E:/Document/Ars/Actio", project: "Actio", projectId: "At",
  ownerId: "owner-1", tokenEnv: "CONCORDIA_ACTIO_TASK_TOKEN", subsidiaryId: null, teamId: "team-1",
};

function task(overrides: Partial<ActioWorkflowTask> = {}): ActioWorkflowTask {
  return {
    id: "task-1", title: "PM モジュールを仕上げる", description: "本文",
    projectId: BINDING.projectId, ownerId: BINDING.ownerId, teamId: null, status: "done",
    source: "cc-taskmd", sourceRef: "spec/tasks/2026-10-02-pm-plan-completion.md", pluginId: null, pluginPayload: null,
    createdAt: "2026-10-02T08:14:59.110Z", deadline: null,
    ...overrides,
  };
}

function client(response: ActioWorkflowTask): { client: ActioWorkflowClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ task: response }));
  return { client: new ActioWorkflowClient({ request } as unknown as ActioTransport), request };
}

describe("ActioWorkflowClient.getReference", () => {
  it("returns a legacy cc-taskmd task in scope as read-only", async () => {
    const { client: c, request } = client(task());
    await expect(c.getReference(BINDING, "task-1")).resolves.toMatchObject({ legacy: true, task: { id: "task-1", status: "done" } });
    expect(request).toHaveBeenCalledWith(BINDING, "GET", "/api/tasks/task-1");
  });

  it("keeps the existing v3 scope for workflow tasks", async () => {
    const v3 = task({ source: ACTIO_WORKFLOW_SOURCE, pluginId: ACTIO_WORKFLOW_SOURCE, teamId: "team-1", pluginPayload: {} });
    await expect(client(v3).client.getReference(BINDING, "task-1")).resolves.toMatchObject({ legacy: false });
    const foreignTeam = task({ source: ACTIO_WORKFLOW_SOURCE, pluginId: ACTIO_WORKFLOW_SOURCE, teamId: "team-2", pluginPayload: {} });
    await expect(client(foreignTeam).client.getReference(BINDING, "task-1")).rejects.toThrow("Actio task ownership mismatch");
  });

  it("rejects tasks from other sources or owners as out of scope", async () => {
    await expect(client(task({ source: "manual" })).client.getReference(BINDING, "task-1")).rejects.toThrow("Actio task ownership mismatch");
    await expect(client(task({ ownerId: "owner-2" })).client.getReference(BINDING, "task-1")).rejects.toThrow("Actio task ownership mismatch");
    await expect(client(task({ projectId: "KD" })).client.getReference(BINDING, "task-1")).rejects.toThrow("Actio task ownership mismatch");
  });

  it("does not loosen the work read (get) for legacy tasks", async () => {
    await expect(client(task()).client.get(BINDING, "task-1")).rejects.toThrow("Actio task ownership mismatch");
  });
});

describe("ActioTaskStore.readReference", () => {
  function store(response: ActioWorkflowTask) {
    const state = new TaskflowStateStore(makeTestDb());
    const register = vi.spyOn(state, "registerActioReference");
    const getReference = vi.fn(async () => ({ task: response, legacy: response.source !== ACTIO_WORKFLOW_SOURCE }));
    const get = vi.fn();
    const actioClient = { getReference, get } as unknown as ActioWorkflowClient;
    return { store: new ActioTaskStore(() => [BINDING], actioClient, state), register, get };
  }

  it("presents a legacy task without registering it in taskflow state", async () => {
    const { store: s, register, get } = store(task());
    const document = await s.readReference(BINDING.repoPath, "actio:task-1", null);
    expect(document).toMatchObject({
      path: "actio:task-1", repoPath: BINDING.repoPath, title: "PM モジュールを仕上げる",
      frontmatter: { task: "task-1", project: "Actio", actio_status: "done", legacy_source: "cc-taskmd" },
    });
    expect(document.runtime).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the normal document for a v3 task", async () => {
    const v3 = task({ source: ACTIO_WORKFLOW_SOURCE, pluginId: ACTIO_WORKFLOW_SOURCE, status: "open", pluginPayload: { kind: "実装" } });
    const { store: s, register } = store(v3);
    const document = await s.readReference(BINDING.repoPath, "actio:task-1", null);
    expect(document.runtime?.status).toBe("pending");
    expect(register).toHaveBeenCalledTimes(1);
  });
});
