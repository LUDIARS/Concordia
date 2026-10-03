/** @implements spec/feature/task-workflow-v3.md — Agent contract / stable source identity */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import {
  ACTIO_WORKFLOW_SOURCE, ActioWorkflowClient, workflowStatus, type ActioWorkflowTask,
} from "./actio-task-client.js";
import type { ActioTransport } from "./actio-transport.js";
import type { TaskPrEvidence } from "./pr-evidence.js";

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

describe("Actio PR and planning adapter", () => {
  const pr: TaskPrEvidence = { provider: "revisor", repository: "owner/repo", id: "pr-1", number: 1, url: null,
    head_sha: "a", reviewed_head_sha: "a", state: "open", review: "test_ok", reflection: "unknown", observed_at: "2026-09-26T00:00:00.000Z" };
  it("serializes PR and worker metadata updates without losing either", async () => {
    let current = task({ pluginPayload: { issued_by_session_id: "issuer", working_session_id: null } });
    const request = vi.fn(async (_binding: ActioBinding, method: string, _path: string, body?: { pluginPayload: Record<string, unknown> }) => {
      if (method === "PATCH") current = { ...current, pluginPayload: body!.pluginPayload };
      return { task: current };
    });
    const client = new ActioWorkflowClient({ request } as unknown as ActioTransport);
    await Promise.all([client.setPrEvidence(BINDING, current.id, pr), client.setWorkingSession(BINDING, current.id, "worker")]);
    expect(current.pluginPayload).toMatchObject({ issued_by_session_id: "issuer", working_session_id: "worker", pull_requests: [pr] });
  });
  it("reconciles an uncertain PATCH by reading the same task on retry", async () => {
    let current = task();
    let patches = 0;
    const request = vi.fn(async (_binding: ActioBinding, method: string, _path: string, body?: { pluginPayload: Record<string, unknown> }) => {
      if (method === "PATCH") { current = { ...current, pluginPayload: body!.pluginPayload }; patches++; throw new Error("unknown outcome"); }
      return { task: current };
    });
    const client = new ActioWorkflowClient({ request } as unknown as ActioTransport);
    await expect(client.setPrEvidence(BINDING, current.id, pr)).rejects.toThrow("unknown outcome");
    await client.setPrEvidence(BINDING, current.id, pr);
    expect(patches).toBe(1);
  });
  it("resolves a human-created prerequisite without selecting it as Cc work", async () => {
    const { transport: t } = transport({ tasks: [task({ blockedBy: ["human"] })] }, { task: task({ id: "human", pluginId: null, status: "done" }) });
    const plan = await new ActioWorkflowClient(t).planning(BINDING);
    expect(plan).toEqual(expect.arrayContaining([expect.objectContaining({ id: "human", status: "done" })]));
  });
  it("uses fresh team critical-path results and surfaces cycles", async () => {
    const team = { ...BINDING, teamId: "team-1" };
    const { transport: t } = transport({ tasks: [task({ teamId: team.teamId })] }, { tasks: [], cycles: [["task-1"]] });
    expect(await new ActioWorkflowClient(t).planning(team)).toEqual([expect.objectContaining({ criticalPathError: "cycle" })]);
  });
});

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
      { ownerId: "owner-2" }, { projectId: "project-2" },
      { source: "other" }, { pluginId: "other" },
      { teamId: "team-9", ownerId: "owner-2" },
    ] as Array<Partial<ActioWorkflowTask>>) {
      const { transport: t } = transport({ tasks: [task(overrides)] });
      await expect(new ActioWorkflowClient(t).list(BINDING)).rejects.toThrow("Actio task ownership mismatch");
    }
  });

  /** Without team_id Actio also returns the project's team tasks; they are not this binding's work. */
  it("skips team tasks returned to a team-less listing instead of refusing the list", async () => {
    const { transport: t } = transport({ tasks: [task(), task({ id: "team-task", teamId: "team-9" })] });

    expect((await new ActioWorkflowClient(t).list(BINDING)).map((item) => item.id)).toEqual(["task-1"]);
  });

  it("keeps a registered candidate team's task on a team-less multi-team listing", async () => {
    const multi = { ...BINDING, teamCandidates: ["team-1", "team-2"] };
    const { transport: t } = transport({ tasks: [task({ teamId: "team-2" }), task({ id: "other", teamId: "team-9" })] });

    expect((await new ActioWorkflowClient(t).list(multi)).map((item) => item.id)).toEqual(["task-1"]);
  });

  it("still refuses another team's task on a team-scoped listing", async () => {
    const team = { ...BINDING, teamId: "team-1" };
    const { transport: t } = transport({ tasks: [task({ teamId: "team-9" })] });

    await expect(new ActioWorkflowClient(t).list(team)).rejects.toThrow("Actio task ownership mismatch");
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

  it("assigns a local team task to the verified local owner without dropping team scope", async () => {
    const binding: ActioBinding = { ...BINDING, teamId: "team-1", ownerId: "actio-local", authMode: "loopback", tokenEnv: undefined };
    const ref = createHash("sha256").update(JSON.stringify([
      binding.projectId, binding.ownerId, binding.teamId, CREATE.sourceRef,
    ])).digest("hex");
    const { transport: t, request } = transport({ tasks: [] }, { task: task({
      ownerId: binding.ownerId, teamId: binding.teamId, sourceRef: ref,
    }) });
    await new ActioWorkflowClient(t).create(binding, CREATE);
    expect(request.mock.calls[1]![3]).toMatchObject({ teamId: "team-1", assigneeId: "actio-local" });
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
