/** @implements spec/feature/task-workflow-v3.md — Actio task sync: work key reuse, runs, title (CC-TF-SYNC-01, CC-TF-SYNC-03, CC-TF-SYNC-04) */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import { ACTIO_WORKFLOW_SOURCE, ActioWorkflowClient, type ActioWorkflowTask } from "./actio-task-client.js";
import type { ActioTransport } from "./actio-transport.js";

const BINDING: ActioBinding = {
  repoPath: "E:/Document/Ars/Concordia", project: "Concordia", projectId: "Cc",
  ownerId: "owner-1", tokenEnv: "CONCORDIA_ACTIO_TASK_TOKEN", subsidiaryId: null, teamId: null,
};
const hashed = (value: string): string => createHash("sha256")
  .update(JSON.stringify([BINDING.projectId, BINDING.ownerId, BINDING.teamId, value])).digest("hex");

function task(overrides: Partial<ActioWorkflowTask> = {}): ActioWorkflowTask {
  return {
    id: "t1", title: "旧タイトル", description: "旧本文", projectId: "Cc", ownerId: "owner-1", teamId: null,
    status: "open", source: ACTIO_WORKFLOW_SOURCE, sourceRef: hashed("work:k"), pluginId: ACTIO_WORKFLOW_SOURCE,
    pluginPayload: { version: 3, kind: "実装", memory_links: [] }, createdAt: "2026-10-11T00:00:00.000Z", ...overrides,
  };
}

/** GET は現在値、PATCH は本文を反映した値を返す。 */
function actio(initial: ActioWorkflowTask) {
  let current = initial;
  const request = vi.fn(async (_binding: ActioBinding, method: string, _path: string, body?: Record<string, unknown>) => {
    if (method === "GET" && _path.startsWith("/api/tasks?")) return { tasks: [current] };
    if (method === "PATCH") current = { ...current, ...body } as ActioWorkflowTask;
    if (method === "POST") current = { ...current, ...body, id: "new" } as ActioWorkflowTask;
    return { task: current };
  });
  return { client: new ActioWorkflowClient({ request } as unknown as ActioTransport), request, current: () => current };
}

const INPUT = { sourceRef: "work:k", title: "新タイトル", body: "新本文", kind: "実装", memoryLinks: [] as string[] };

describe("ActioWorkflowClient work key reuse", () => {
  it("reuses a task with the same work key even when the body differs", async () => {
    const { client, request } = actio(task());
    const result = await client.create(BINDING, { ...INPUT, reuseExisting: true });
    expect(result).toMatchObject({ existed: true, task: { id: "t1", title: "旧タイトル" } });
    expect(request.mock.calls.some((call) => call[1] === "POST")).toBe(false);
  });

  it("still refuses a content mismatch for request identities that are not work keys", async () => {
    const { client } = actio(task());
    await expect(client.create(BINDING, INPUT)).rejects.toThrow("reused with different content");
  });

  it("records the template name in the payload instead of the title", async () => {
    const { client, request } = actio(task({ sourceRef: "other" }));
    await client.create(BINDING, { ...INPUT, template: "実装委託 (Opus 5.5)" }).catch(() => undefined);
    const post = request.mock.calls.find((call) => call[1] === "POST")![3] as { title: string; pluginPayload: Record<string, unknown> };
    expect(post.title).toBe("新タイトル");
    expect(post.pluginPayload.template).toBe("実装委託 (Opus 5.5)");
  });
});

describe("ActioWorkflowClient run records", () => {
  it("records the run, appends the new instruction and resumes an open task", async () => {
    const { client, current } = actio(task());
    await client.recordRunStart(BINDING, "t1", { runId: "r2", sessionId: null, at: "t", instruction: "続きの指示" });
    expect(current().status).toBe("in_progress");
    expect(current().description).toContain("## 続きの指示 (run r2)\n\n続きの指示");
    expect(current().pluginPayload?.runs).toEqual([{ run_id: "r2", session_id: null, started_at: "t", ended_at: null }]);
  });

  it("leaves a dependency-blocked task blocked and does not repeat an instruction already in the body", async () => {
    const { client, request, current } = actio(task({ status: "blocked", description: "旧本文" }));
    await client.recordRunStart(BINDING, "t1", { runId: "r1", sessionId: null, at: "t", instruction: "旧本文" });
    const patch = request.mock.calls.find((call) => call[1] === "PATCH")![3] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("description");
    expect(current().status).toBe("blocked");
  });

  it("closes the run on end and skips the write when nothing changes", async () => {
    const { client, request, current } = actio(task({ pluginPayload: { runs: [{ run_id: "r1", session_id: null, started_at: "t", ended_at: null }] } }));
    await client.recordRunEnd(BINDING, "t1", { runId: "r1", at: "t2", reason: "completed" });
    expect(current().pluginPayload?.runs).toEqual([{ run_id: "r1", session_id: null, started_at: "t", ended_at: "t2", end_reason: "completed" }]);
    const writes = request.mock.calls.filter((call) => call[1] === "PATCH").length;
    await client.recordRunEnd(BINDING, "t1", { runId: "r1", at: "t3", reason: "failed" });
    expect(request.mock.calls.filter((call) => call[1] === "PATCH").length).toBe(writes);
  });
});
