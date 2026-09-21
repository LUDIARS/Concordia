/** @implements spec/feature/task-workflow-v3.md — Agent contract / stable source identity */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import {
  ACTIO_WORKFLOW_SOURCE, ActioWorkflowClient, workflowStatus, type ActioWorkflowTask,
} from "./actio-task-client.js";
import type { ActioTransport } from "./actio-transport.js";

const BINDING: ActioBinding = {
  repoPath: "E:/Document/Ars/Concordia", project: "Concordia", projectId: "project-1",
  ownerId: "owner-1", tokenEnv: "CONCORDIA_ACTIO_TASK_TOKEN", subsidiaryId: null, teamId: null,
};

const sourceRef = (value: string): string => createHash("sha256")
  .update(JSON.stringify([BINDING.projectId, BINDING.ownerId, BINDING.teamId, value])).digest("hex");

function task(overrides: Partial<ActioWorkflowTask> = {}): ActioWorkflowTask {
  return {
    id: "task-1", title: "タイトル", description: "本文",
    projectId: BINDING.projectId, ownerId: BINDING.ownerId, teamId: BINDING.teamId,
    status: "open", source: ACTIO_WORKFLOW_SOURCE, sourceRef: sourceRef("session:s1:req-1"),
    pluginId: ACTIO_WORKFLOW_SOURCE, pluginPayload: { version: 3, kind: "実装", memory_links: [] },
    createdAt: "2026-09-21T00:00:00.000Z", deadline: null,
    ...overrides,
  };
}

/** Replays queued responses in call order and records the requests made. */
function transport(...responses: unknown[]) {
  const request = vi.fn(
    async (_binding: ActioBinding, _method: string, _path: string, _body?: unknown) => responses.shift(),
  );
  return { transport: { request } as unknown as ActioTransport, request };
}

const CREATE = {
  sourceRef: "session:s1:req-1", title: "タイトル", body: "本文", kind: "実装", memoryLinks: [] as string[],
};

describe("workflowStatus", () => {
  it("maps Actio business status onto the Cc vocabulary", () => {
    expect(workflowStatus("open")).toBe("pending");
    expect(workflowStatus("in_progress")).toBe("delegated");
    expect(workflowStatus("blocked")).toBe("delegated");
    expect(workflowStatus("done")).toBe("done");
    expect(workflowStatus("cancelled")).toBe("cancelled");
  });
});

describe("ActioWorkflowClient", () => {
  it("lists only the configured project, owner and workflow source", async () => {
    const { transport: t, request } = transport({ tasks: [task()] });

    expect(await new ActioWorkflowClient(t).list(BINDING)).toHaveLength(1);
    const [, method, path] = request.mock.calls[0]!;
    expect(method).toBe("GET");
    expect(path).toContain("scope=owned");
    expect(path).toContain(`project=${BINDING.projectId}`);
    expect(path).toContain(`pluginId=${encodeURIComponent(ACTIO_WORKFLOW_SOURCE)}`);
  });

  it("sends the team scope for a subsidiary binding", async () => {
    const team = { ...BINDING, subsidiaryId: "sub-1", teamId: "team-1" };
    const { transport: t, request } = transport({ tasks: [] });

    await new ActioWorkflowClient(t).list(team);

    expect(request.mock.calls[0]![2]).toContain("team_id=team-1");
  });

  /** Cc cannot protect direct Actio access, so a response outside the scope is refused. */
  it("rejects a task that belongs to another owner, project or workflow", async () => {
    for (const overrides of [
      { ownerId: "owner-2" }, { projectId: "project-2" }, { teamId: "team-9" },
      { source: "other" }, { pluginId: "other" },
    ] as Array<Partial<ActioWorkflowTask>>) {
      const { transport: t } = transport({ tasks: [task(overrides)] });
      await expect(new ActioWorkflowClient(t).list(BINDING)).rejects.toThrow("Actio task ownership mismatch");
    }
  });

  it("refuses a response that does not match the task contract", async () => {
    const { transport: list } = transport({ tasks: [{ id: "task-1" }] });
    await expect(new ActioWorkflowClient(list).list(BINDING)).rejects.toThrow("Invalid Actio task list response");

    const { transport: get } = transport({ task: { id: "task-1" } });
    await expect(new ActioWorkflowClient(get).get(BINDING, "task-1")).rejects.toThrow("Invalid Actio task response");
  });

  it("derives a stable source identity and creates the task once", async () => {
    const { transport: t, request } = transport({ tasks: [] }, { task: task() });

    const result = await new ActioWorkflowClient(t).create(BINDING, CREATE);

    expect(result.existed).toBe(false);
    const body = request.mock.calls[1]![3];
    expect(body).toMatchObject({
      title: "タイトル", description: "本文", projectId: BINDING.projectId,
      source: ACTIO_WORKFLOW_SOURCE, sourceRef: sourceRef("session:s1:req-1"),
      status: "open", creatorType: "ai", deadline: null,
      pluginPayload: { version: 3, kind: "実装", memory_links: [] },
    });
  });

  /** A lost response must be retried with the same identity, not create a second task. */
  it("returns the existing task instead of creating a duplicate", async () => {
    const { transport: t, request } = transport({ tasks: [task()] });

    expect(await new ActioWorkflowClient(t).create(BINDING, CREATE)).toEqual({ task: task(), existed: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses to reuse a request identity with different content", async () => {
    const { transport: t } = transport({ tasks: [task({ description: "別の本文" })] });

    await expect(new ActioWorkflowClient(t).create(BINDING, CREATE))
      .rejects.toThrow("Actio task request identity reused with different content");
  });

  it("rejects a created task whose source identity is not the one that was sent", async () => {
    const { transport: t } = transport({ tasks: [] }, { task: task({ sourceRef: sourceRef("other") }) });

    await expect(new ActioWorkflowClient(t).create(BINDING, CREATE)).rejects.toThrow("Actio source identity mismatch");
  });

  it("confirms ownership before writing a status", async () => {
    const { transport: t, request } = transport({ task: task() }, { task: task({ status: "in_progress" }) });

    await new ActioWorkflowClient(t).setStatus(BINDING, "task-1", "delegated");

    expect(request.mock.calls[0]![1]).toBe("GET");
    const [, method, path, body] = request.mock.calls[1]!;
    expect(method).toBe("PATCH");
    expect(path).toBe("/api/tasks/task-1");
    expect(body).toEqual({ status: "in_progress" });
  });

  it("does not write a status to a task owned by someone else", async () => {
    const { transport: t, request } = transport({ task: task({ ownerId: "owner-2" }) });

    await expect(new ActioWorkflowClient(t).setStatus(BINDING, "task-1", "done"))
      .rejects.toThrow("Actio task ownership mismatch");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
