/** @implements spec/feature/task-workflow-v3.md — Actio content authority, Cc keeps references only */

import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { ActioBinding } from "./actio-binding.js";
import { ActioTaskStore } from "./actio-store.js";
import { ACTIO_WORKFLOW_SOURCE, type ActioWorkflowClient, type ActioWorkflowTask } from "./actio-task-client.js";
import { TaskflowStateStore } from "./state-store.js";
import type { TaskStatus } from "./types.js";

const HQ: ActioBinding = {
  repoPath: "E:/Document/Ars/Concordia", project: "Concordia", projectId: "project-1",
  ownerId: "owner-1", tokenEnv: "CONCORDIA_ACTIO_TASK_TOKEN", subsidiaryId: null, teamId: null,
};
const SUB: ActioBinding = {
  ...HQ, project: "Concordia", projectId: "project-2", subsidiaryId: "sub-1", teamId: "team-1",
};

function task(overrides: Partial<ActioWorkflowTask> = {}): ActioWorkflowTask {
  return {
    id: "task-1", title: "タイトル", description: "本文",
    projectId: HQ.projectId, ownerId: HQ.ownerId, teamId: null, status: "open",
    source: ACTIO_WORKFLOW_SOURCE, sourceRef: "ref", pluginId: ACTIO_WORKFLOW_SOURCE,
    pluginPayload: { version: 3, kind: "調査", memory_links: ["mem-1", 7] },
    createdAt: "2026-09-21T09:30:00.000Z", deadline: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

type CreateInput = Parameters<ActioWorkflowClient["create"]>[1];

function fixture(bindings: ActioBinding[] = [HQ], override: Partial<ActioWorkflowClient> = {}) {
  const state = new TaskflowStateStore(makeTestDb());
  const list = vi.fn(async (_binding: ActioBinding) => [task()]);
  const get = vi.fn(async (_binding: ActioBinding, _id: string) => task());
  const create = vi.fn(async (_binding: ActioBinding, _input: CreateInput) => ({ task: task(), existed: false }));
  const setStatus = vi.fn(async (_binding: ActioBinding, _id: string, _status: TaskStatus) => undefined);
  const client = { list, get, create, setStatus, ...override } as unknown as ActioWorkflowClient;
  return { state, list, get, create, setStatus, store: new ActioTaskStore(() => bindings, client, state) };
}

describe("ActioTaskStore", () => {
  it("presents an Actio task as a reference-only document", async () => {
    const { store } = fixture();

    const [document] = await store.scan();

    expect(document).toMatchObject({
      path: "actio:task-1", repoPath: HQ.repoPath, title: "タイトル", body: "本文",
      frontmatter: { task: "task-1", project: "Concordia", kind: "調査", created: "2026-09-21", memory_links: ["mem-1"] },
      runtime: { status: "pending", subsidiary_id: null, actio_task_id: "task-1" },
    });
    expect(store.relativePath(document!)).toBe("actio:task-1");
  });

  it("filters a project listing by the requested statuses", async () => {
    const { store } = fixture([HQ], { list: async () => [task(), task({ id: "task-2", status: "done" })] });

    expect(await store.findForProject("concordia", ["done"])).toHaveLength(1);
    expect(await store.findForProject("concordia")).toHaveLength(2);
  });

  /** A task file path is not a reference; following one would reopen the file route. */
  it("refuses a legacy Markdown reference", async () => {
    const { store } = fixture();

    await expect(store.findByRelativePath(HQ.repoPath, "spec/tasks/2026-09-21-x.md"))
      .rejects.toThrow("Legacy task file references require explicit Actio migration");
  });

  it("reads a status through the Actio reference", async () => {
    const { store } = fixture([HQ], { get: async () => task({ status: "in_progress" }) });

    expect(await store.findByRelativePath(HQ.repoPath, "actio:task-1")).toEqual({ status: "delegated" });
  });

  it("resolves the binding by project name and by repository path", async () => {
    const { store, get, list } = fixture();

    await store.read(HQ.repoPath, "actio:task-1", null);
    await store.findForProject("CONCORDIA");

    expect(get.mock.calls[0]![0]).toEqual(HQ);
    expect(list.mock.calls[0]![0]).toEqual(HQ);
  });

  /** An ambiguous or absent binding must stop the operation, never pick a default. */
  it("stops when the binding is missing or ambiguous", async () => {
    const missing = fixture([]);
    await expect(missing.store.findForProject("concordia"))
      .rejects.toThrow("Actio task project binding missing or ambiguous");

    const ambiguous = fixture([HQ, { ...HQ, projectId: "project-3" }]);
    await expect(ambiguous.store.findForProject("concordia"))
      .rejects.toThrow("Actio task project binding missing or ambiguous");
  });

  it("selects the subsidiary binding when an organization is given", async () => {
    const { store, get } = fixture([HQ, SUB]);

    await store.read(HQ.repoPath, "actio:task-1", "sub-1");

    expect(get.mock.calls[0]![0]).toEqual(SUB);
  });

  it("creates a task and returns its reference", async () => {
    const { store, create } = fixture();

    const document = await store.create({
      repoPath: HQ.repoPath, subsidiaryId: null, sourceRef: "session:s1:req-1",
      title: "タイトル", body: "本文", kind: "実装", memoryLinks: [],
    });

    expect(document.path).toBe("actio:task-1");
    expect(create.mock.calls[0]![0]).toEqual(HQ);
  });

  it("writes a status through the client", async () => {
    const { store, setStatus } = fixture();

    await store.updateStatus(HQ.repoPath, "actio:task-1", "done", null);

    expect(setStatus).toHaveBeenCalledWith(HQ, "task-1", "done");
  });

  it("requires an Actio reference before touching a status", async () => {
    const { store } = fixture();

    await expect(store.updateStatus(HQ.repoPath, "spec/tasks/x.md", "done", null))
      .rejects.toThrow("Actio task reference required");
  });

  /** One delegation per task: a second run must inspect the first instead of racing it. */
  it("claims a task for one delegation run and releases it again", async () => {
    const { store } = fixture();
    const [document] = await store.scan();

    store.associate(document!, "run-1", "session-1");
    expect(() => store.associate(document!, "run-2", "session-2"))
      .toThrow("Actio task already associated with a delegation; inspect that run before retry");

    store.releaseExecution("run-1");
    expect(() => store.associate(document!, "run-2", "session-2")).not.toThrow();
  });

  it("derives a stable identity per remaining item so a retry does not duplicate it", async () => {
    const created = new Set<string>();
    const { store } = fixture([HQ], {
      create: async (_binding: ActioBinding, input: CreateInput) => {
        const existed = created.has(input.sourceRef);
        created.add(input.sourceRef);
        return { task: task({ id: input.title, title: input.title }), existed };
      },
    });
    const input = {
      repoPath: HQ.repoPath, sourceRunId: "run-1", project: "Concordia", subsidiaryId: null,
      remaining: [{ title: "残り1", note: "理由", scope_dirs: ["src/taskflow"] }, { title: "残り2" }],
    };

    expect(await store.writeRemainingTasks(input)).toEqual({ created: ["actio:残り1", "actio:残り2"], existed: [] });
    expect(await store.writeRemainingTasks(input)).toEqual({ created: [], existed: ["actio:残り1", "actio:残り2"] });
  });
});
