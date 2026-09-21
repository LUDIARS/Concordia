/** @implements spec/feature/task-workflow-v3.md — delegation moves rendered content to Actio first */

import { describe, expect, it, vi } from "vitest";
import type { TaskCreateInput, TaskStore } from "../taskflow/store.js";
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
  return { create, associate, document, store: { create, associate, ...override } as unknown as TaskStore };
}

describe("sealDelegationTask", () => {
  it("stores the rendered content in Actio and hands the child only a reference", async () => {
    const { store, create } = fixture();

    const sealed = await sealDelegationTask({
      store, definition: definition(), invocation: invocation(), runId: "run-1", content: CONTENT,
    });

    expect(sealed.reference).toBe("actio:task-1");
    expect(create.mock.calls[0]![0]).toMatchObject({
      repoPath: REPO, subsidiaryId: null, title: "実装委託 (Opus / xhigh)", body: CONTENT,
      kind: "実装", memoryLinks: ["mem-1"], status: "delegated",
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

    expect(associate).toHaveBeenCalledWith(document, "run-1", "parent-1");
  });

  /** Identity is derived from the request, so a lost response retries onto the same task. */
  it("derives the same source identity for an identical request", async () => {
    const { store: a, create: createA } = fixture();
    const { store: b, create: createB } = fixture();
    const input = { definition: definition(), invocation: invocation(), runId: "run-1", content: CONTENT };

    await sealDelegationTask({ ...input, store: a });
    await sealDelegationTask({ ...input, store: b, runId: "run-2" });

    const reference = createA.mock.calls[0]![0].sourceRef;
    expect(createB.mock.calls[0]![0].sourceRef).toBe(reference);
    expect(reference).toMatch(/^delegation:[0-9a-f]{64}$/);

    const { store: c, create: createC } = fixture();
    await sealDelegationTask({ ...input, store: c, content: "別の本文" });
    expect(createC.mock.calls[0]![0].sourceRef).not.toBe(reference);
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
