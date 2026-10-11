/** @implements spec/feature/task-workflow-v3.md — delegation moves rendered content to Actio first; Actio task sync (CC-TF-SYNC-01..04) */

import { describe, expect, it, vi } from "vitest";
import type { TaskCreateInput, TaskRunStart, TaskStore } from "../taskflow/store.js";
import type { TaskDocument } from "../taskflow/types.js";
import { sealDelegationTask } from "./actio-task.js";
import type { DelegationDefinition, InvokeInput } from "./contracts.js";

const REPO = "E:/Document/Ars/Concordia";
const CONTENT = "秘密を含む委託本文";

const definition = (overrides: Partial<DelegationDefinition> = {}): DelegationDefinition => ({
  template_id: "tpl-1", call_name: "implementation", title: "実装委託 (Opus / xhigh)",
  target_provider: "claude", model: "claude-opus-5", prompt_template: CONTENT,
  input_schema: '[{"name":"task"}]', default_cwd: REPO, ...overrides,
});

const invocation = (overrides: Partial<InvokeInput> = {}): InvokeInput => ({
  call_name: "implementation", args: { task: CONTENT, secret: "value" },
  cwd: REPO, extra_prompt: CONTENT, memory_links: ["mem-1"],
  parent_session_id: "parent-1", branch: "feat/x", memoria_task_id: 2816,
  memoria_task_title: "旧タスク", ...overrides,
});

function fixture(override: Partial<TaskStore> = {}) {
  const document: TaskDocument = {
    path: "actio:task-1", repoPath: REPO, title: "実装委託 (Opus / xhigh)", body: CONTENT,
    frontmatter: { task: "task-1", project: "Concordia", kind: "実装", created: "2026-09-21" },
  };
  const create = vi.fn(async (_input: TaskCreateInput) => document);
  const associate = vi.fn((_document: TaskDocument, _runId: string, _sessionId: string | null) => undefined);
  const recordRunStart = vi.fn(async (_document: TaskDocument, _run: TaskRunStart) => undefined);
  const releaseExecution = vi.fn((_runId: string) => undefined);
  const read = vi.fn(async (_repo: string, reference: string, _subsidiary: string | null): Promise<TaskDocument> =>
    ({ ...document, path: reference, runtime: { status: "delegated" } as TaskDocument["runtime"] }));
  return { create, associate, recordRunStart, releaseExecution, read, document,
    store: { create, associate, recordRunStart, releaseExecution, read, ...override } as unknown as TaskStore };
}

describe("sealDelegationTask", () => {
  /** CC-AT-TEAM-02: the invoke's actio_team_id is the only team the store may use. */
  it("passes an explicit actio_team_id to the task store", async () => {
    const { store, create } = fixture();
    await sealDelegationTask({
      store, definition: definition(), invocation: invocation({ actio_team_id: "team_b" }), runId: "run-1", content: CONTENT,
    });
    expect(create.mock.calls[0]![0].teamId).toBe("team_b");
  });

  it("does not associate a run when the store rejects the requested team", async () => {
    const { store, associate } = fixture({
      create: vi.fn(async () => { throw new Error("Actio team is not registered for the project"); }),
    });
    await expect(sealDelegationTask({
      store, definition: definition(), invocation: invocation({ actio_team_id: "unknown" }), runId: "run-1", content: CONTENT,
    })).rejects.toThrow("not registered");
    expect(associate).not.toHaveBeenCalled();
  });

  it("stores the rendered content in Actio and hands the child only a reference", async () => {
    const { store, create } = fixture();

    const sealed = await sealDelegationTask({
      store, definition: definition(), invocation: invocation(), runId: "run-1", content: CONTENT,
    });

    expect(sealed.reference).toBe("actio:task-1");
    expect(create.mock.calls[0]![0]).toMatchObject({
      repoPath: REPO, subsidiaryId: null, title: CONTENT, template: "実装委託 (Opus / xhigh)", reuseExisting: true, body: CONTENT,
      kind: "実装", memoryLinks: ["mem-1"], status: "delegated",
      issuedBySessionId: "parent-1", teamId: null,
    });
    expect(sealed.prompt).toContain("actio:task-1");
    expect(sealed.prompt).not.toContain(CONTENT);
  });

  /** The run row, queue payload and prompt file are all built from these two values. */
  it("clears every field that would persist the body outside Actio", async () => {
    const { store } = fixture();

    const sealed = await sealDelegationTask({
      store, definition: definition(), invocation: invocation(), runId: "run-1", content: CONTENT,
    });

    expect(sealed.definition.prompt_template).toBe(sealed.prompt);
    expect(sealed.definition.input_schema).toBe("[]");
    expect(sealed.invocation.args).toEqual({ target_repo: REPO, taskflow_reference: "actio:task-1" });
    expect(sealed.invocation.extra_prompt).toBeUndefined();
    expect(sealed.invocation.memory_links).toEqual([]);
    expect(sealed.invocation.memoria_task_id).toBeUndefined();
    expect(sealed.invocation.memoria_task_title).toBeUndefined();
    expect(JSON.stringify(sealed.invocation)).not.toContain(CONTENT);
  });

  it("claims the task for this run so a retry cannot fork a second delegation", async () => {
    const { store, associate, document } = fixture();

    await sealDelegationTask({
      store, definition: definition(), invocation: invocation(), runId: "run-1", content: CONTENT,
    });

    expect(associate).toHaveBeenCalledWith(document, "run-1", null);
  });

  /** CC-TF-SYNC-01: the work key, not the rendered body, identifies the task. */
  it("derives the same work key when only the rendered body changes", async () => {
    const { store: a, create: createA } = fixture();
    const { store: b, create: createB } = fixture();
    const input = { definition: definition(), invocation: invocation(), runId: "run-1", content: CONTENT };

    await sealDelegationTask({ ...input, store: a });
    await sealDelegationTask({ ...input, store: b, runId: "run-2", content: "別の本文 (引き継ぎ)" });

    const reference = createA.mock.calls[0]![0].sourceRef;
    expect(reference).toBe("work:e:/document/ars/concordia:feat/x:秘密を含む委託本文");
    expect(createB.mock.calls[0]![0].sourceRef).toBe(reference);
  });

  /** CC-TF-SYNC-02: an explicit reference continues that task; no new task is created. */
  it("continues the referenced task and records the run with the new instruction", async () => {
    const { store, create, read, associate, recordRunStart } = fixture();
    const sealed = await sealDelegationTask({
      store, definition: definition(), invocation: invocation({ args: { task: "続き", taskflow_reference: "actio:prev" } }),
      runId: "run-2", content: "続きの指示",
    });
    expect(create).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(REPO, "actio:prev", null);
    expect(sealed.reference).toBe("actio:prev");
    expect(associate.mock.calls[0]![1]).toBe("run-2");
    expect(recordRunStart.mock.calls[0]![1]).toEqual({ runId: "run-2", sessionId: null, instruction: "続きの指示" });
  });

  /** CC-TF-SYNC-02: a predecessor that ended on the same branch hands its task over automatically. */
  it("reuses the handoff task found on the same repository and branch", async () => {
    const { store, create } = fixture();
    const finder = vi.fn(() => "actio:lost");
    const sealed = await sealDelegationTask({
      store, definition: definition(), invocation: invocation(), runId: "run-2", content: CONTENT, findHandoffReference: finder,
    });
    expect(finder).toHaveBeenCalledWith({ repoPath: REPO, branch: "feat/x" });
    expect(sealed.reference).toBe("actio:lost");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not hand over a finished task and creates by work key instead", async () => {
    const { store, create, document } = fixture({
      read: vi.fn(async () => ({ ...fixture().document, path: "actio:done", runtime: { status: "done" } as TaskDocument["runtime"] })),
    });
    const sealed = await sealDelegationTask({
      store, definition: definition(), invocation: invocation(), runId: "run-2", content: CONTENT, findHandoffReference: () => "actio:done",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sealed.reference).toBe(document.path);
  });

  /** CC-TF-SYNC-03: a failed run record must not leave the task claimed by a run that never launched. */
  it("releases the claim when the run record cannot be written", async () => {
    const { store, releaseExecution } = fixture({ recordRunStart: vi.fn(async () => { throw new Error("Actio down"); }) });
    await expect(sealDelegationTask({
      store, definition: definition(), invocation: invocation(), runId: "run-1", content: CONTENT,
    })).rejects.toThrow("Actio down");
    expect(releaseExecution).toHaveBeenCalledWith("run-1");
  });

  it("falls back to the template's default working directory", async () => {
    const { store, create } = fixture();

    const sealed = await sealDelegationTask({
      store, definition: definition({ default_cwd: " ${target_repo} " }),
      invocation: invocation({ cwd: undefined, args: { target_repo: REPO } }),
      runId: "run-1", content: CONTENT,
    });

    expect(sealed.definition.default_cwd).toBe(REPO);
    expect(create.mock.calls[0]![0].repoPath).toBe(REPO);
  });

  it("refuses to launch without a repository binding or an Actio-backed store", async () => {
    const { store } = fixture();

    await expect(sealDelegationTask({
      store, definition: definition({ default_cwd: null }), invocation: invocation({ cwd: undefined }),
      runId: "run-1", content: CONTENT,
    })).rejects.toThrow("Actio task store and repository binding are required");

    await expect(sealDelegationTask({
      store: fixture({ create: undefined }).store, definition: definition(), invocation: invocation(),
      runId: "run-1", content: CONTENT,
    })).rejects.toThrow("Actio task store and repository binding are required");
  });

  it("keeps a subsidiary invocation inside its own organization", async () => {
    const { store, create } = fixture();

    await sealDelegationTask({
      store, definition: definition(), invocation: invocation({ subsidiary_id: "sub-1" }),
      runId: "run-1", content: CONTENT,
    });

    expect(create.mock.calls[0]![0].subsidiaryId).toBe("sub-1");
  });
});
