import { z } from "zod";
import { createHash } from "node:crypto";
import type { ActioBinding } from "./actio-binding.js";
import type { ActioTransport } from "./actio-transport.js";
import type { TaskStatus } from "./types.js";
import { taskTeamInScope } from "./actio-team-selection.js";
import { isLegacyReferenceInScope } from "./actio-reference-scope.js";
import { assignTaskWorker, taskSessionMetadata } from "./session-metadata.js";
import { mergeTaskPrEvidence, TaskPrEvidence } from "./pr-evidence.js";
import type { PlanningTask } from "./continuation-plan.js";

const Task = z.object({
  id: z.string().min(1), title: z.string(), description: z.string().nullable(),
  projectId: z.string().nullable(), ownerId: z.string(), teamId: z.string().nullable(),
  status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]),
  source: z.string().nullable(), sourceRef: z.string().nullable(),
  pluginId: z.string().nullable(), pluginPayload: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  deadline: z.string().nullable().optional(),
  blockedBy: z.array(z.string()).optional(),
  isCriticalPath: z.boolean().optional(),
  slackDays: z.number().nullable().optional(),
  criticalPathError: z.string().nullable().optional(),
});
export type ActioWorkflowTask = z.infer<typeof Task>;
export const ACTIO_WORKFLOW_SOURCE = "concordia.taskflow.v3";

export function workflowStatus(status: ActioWorkflowTask["status"]): TaskStatus {
  return status === "open" ? "pending" : status === "done" || status === "cancelled" ? status : "delegated";
}

/** Maps Actio's task contract without weakening the configured ownership scope. */
export class ActioWorkflowClient {
  private readonly metadataWrites = new Map<string, Promise<void>>();
  constructor(private readonly transport: ActioTransport) {}

  async list(binding: ActioBinding): Promise<ActioWorkflowTask[]> {
    const query = new URLSearchParams({ scope: "owned", project: binding.projectId, pluginId: ACTIO_WORKFLOW_SOURCE });
    if (binding.teamId) query.set("team_id", binding.teamId);
    const result = z.object({ tasks: z.array(Task) }).safeParse(await this.transport.request(binding, "GET", `/api/tasks?${query}`));
    if (!result.success) throw new Error("Invalid Actio task list response");
    return result.data.tasks.map((task) => this.scoped(binding, task));
  }

  async get(binding: ActioBinding, id: string): Promise<ActioWorkflowTask> {
    return this.decode(binding, await this.transport.request(binding, "GET", `/api/tasks/${encodeURIComponent(id)}`));
  }

  /**
   * 指示参照の関連付け・表示のためだけの読み込み (CC-TASK-LINKED-FOLLOWUP)。v3 タスクは get と同じ範囲、
   * 旧来タスク (cc-taskmd) は isLegacyReferenceInScope の範囲で受け入れる。書き込み・作業候補の判定には使わない。
   */
  async getReference(binding: ActioBinding, id: string): Promise<{ task: ActioWorkflowTask; legacy: boolean }> {
    const result = z.object({ task: Task }).safeParse(await this.transport.request(binding, "GET", `/api/tasks/${encodeURIComponent(id)}`));
    if (!result.success) throw new Error("Invalid Actio task response");
    const task = result.data.task;
    if (task.source === ACTIO_WORKFLOW_SOURCE) return { task: this.scoped(binding, task), legacy: false };
    if (!isLegacyReferenceInScope(binding, task)) throw new Error("Actio task ownership mismatch");
    return { task, legacy: true };
  }

  async create(binding: ActioBinding, input: {
    issuedBySessionId?: string | null;
    sourceRef: string; title: string; body: string; kind: string; memoryLinks: string[]; status?: TaskStatus; dueAt?: string | null;
  }): Promise<{ task: ActioWorkflowTask; existed: boolean }> {
    const sourceRef = createHash("sha256").update(JSON.stringify([
      binding.projectId, binding.ownerId, binding.teamId, input.sourceRef,
    ])).digest("hex");
    const verifyContent = (task: ActioWorkflowTask): void => {
      if (task.title !== input.title || (task.description ?? "") !== input.body
        || task.pluginPayload?.kind !== input.kind
        || JSON.stringify(task.pluginPayload?.memory_links) !== JSON.stringify(input.memoryLinks)) {
        throw new Error("Actio task request identity reused with different content");
      }
    };
    const existing = (await this.list(binding)).find((task) => task.sourceRef === sourceRef);
    if (existing) { verifyContent(existing); return { task: existing, existed: true }; }
    const task = this.decode(binding, await this.transport.request(binding, "POST", "/api/tasks", {
      title: input.title, description: input.body, projectId: binding.projectId, teamId: binding.teamId,
      // Local deployment has one verified owner; team tasks require an assignee.
      ...(binding.teamId && binding.authMode === "loopback" ? { assigneeId: binding.ownerId } : {}),
      source: ACTIO_WORKFLOW_SOURCE, sourceRef,
      pluginId: ACTIO_WORKFLOW_SOURCE, pluginRef: sourceRef,
      pluginPayload: { version: 3, kind: input.kind, memory_links: input.memoryLinks,
        issued_by_session_id: input.issuedBySessionId ?? null, working_session_id: null },
      status: this.remoteStatus(input.status ?? "pending"), creatorType: "ai",
      deadline: input.dueAt ?? null,
    }));
    if (task.sourceRef !== sourceRef) throw new Error("Actio source identity mismatch");
    verifyContent(task);
    const sessions = taskSessionMetadata(task.pluginPayload);
    if (sessions.issued_by_session_id !== (input.issuedBySessionId ?? null) || sessions.working_session_id !== null) {
      throw new Error("Invalid Actio session metadata");
    }
    return { task, existed: false };
  }

  async setStatus(binding: ActioBinding, id: string, status: TaskStatus): Promise<void> {
    await this.get(binding, id);
    this.decode(binding, await this.transport.request(binding, "PATCH", `/api/tasks/${encodeURIComponent(id)}`, { status: this.remoteStatus(status) }));
  }

  async setWorkingSession(binding: ActioBinding, id: string, worker: string | null, expected?: string | null): Promise<void> {
    return this.serializeMetadata(binding, id, () => this.writeWorkingSession(binding, id, worker, expected));
  }

  async setPrEvidence(binding: ActioBinding, id: string, evidence: TaskPrEvidence): Promise<void> {
    return this.serializeMetadata(binding, id, async () => {
      const current = await this.get(binding, id);
      const pluginPayload = mergeTaskPrEvidence(current.pluginPayload, evidence);
      if (JSON.stringify(pluginPayload) === JSON.stringify(current.pluginPayload)) return;
      const updated = this.decode(binding, await this.transport.request(binding, "PATCH", `/api/tasks/${encodeURIComponent(id)}`, { pluginPayload }));
      if (JSON.stringify(updated.pluginPayload) !== JSON.stringify(pluginPayload)) throw new Error("Actio PR evidence update was not confirmed");
    });
  }

  async planning(binding: ActioBinding): Promise<PlanningTask[]> {
    const tasks = await this.list(binding);
    const graph = binding.teamId ? z.object({ tasks: z.array(z.object({ id: z.string(), isCriticalPath: z.boolean(), slackDays: z.number() })), cycles: z.array(z.array(z.string())) })
      .parse(await this.transport.request(binding, "GET", `/api/teams/${encodeURIComponent(binding.teamId)}/critical-path`)) : null;
    const planning = tasks.map((task) => {
      const computed = graph?.tasks.find((item) => item.id === task.id);
      return { id: task.id, status: task.status, blockedBy: task.blockedBy ?? [],
        workingSessionId: taskSessionMetadata(task.pluginPayload).working_session_id,
        isCriticalPath: computed?.isCriticalPath ?? task.isCriticalPath ?? false,
        slackDays: computed?.slackDays ?? task.slackDays ?? null,
        criticalPathError: graph?.cycles.some((cycle) => cycle.includes(task.id)) ? "cycle" : task.criticalPathError ?? null,
        pullRequests: task.pluginPayload?.pull_requests === undefined ? [] : z.array(TaskPrEvidence).parse(task.pluginPayload.pull_requests) };
    });
    // Human-created prerequisites may not carry the Cc plugin ID. Read those
    // through the same authenticated scope without making them work candidates.
    const dependencyIds = [...new Set(tasks.flatMap((task) => task.blockedBy ?? []))].filter((id) => !tasks.some((task) => task.id === id));
    for (const id of dependencyIds) {
      const dependency = z.object({ task: Task }).parse(await this.transport.request(binding, "GET", `/api/tasks/${encodeURIComponent(id)}`)).task;
      if (!taskTeamInScope(binding, dependency.teamId) || (!dependency.teamId && dependency.ownerId !== binding.ownerId)) throw new Error("Actio dependency ownership mismatch");
      planning.push({ id, status: dependency.status === "done" ? "done" : "blocked", blockedBy: [],
        workingSessionId: null,
        isCriticalPath: false, slackDays: null, criticalPathError: null, pullRequests: [] });
    }
    return planning;
  }

  private async serializeMetadata(binding: ActioBinding, id: string, write: () => Promise<void>): Promise<void> {
    const key = JSON.stringify([binding.ownerId, binding.projectId, binding.teamId, id]);
    const previous = this.metadataWrites.get(key);
    const operation = (async () => { await previous?.catch(() => undefined); await write(); })();
    this.metadataWrites.set(key, operation);
    try { await operation; }
    finally { if (this.metadataWrites.get(key) === operation) this.metadataWrites.delete(key); }
  }

  private async writeWorkingSession(binding: ActioBinding, id: string, worker: string | null, expected?: string | null): Promise<void> {
    const current = await this.get(binding, id);
    const pluginPayload = assignTaskWorker(current.pluginPayload, worker, expected);
    if (taskSessionMetadata(current.pluginPayload).working_session_id === worker) return;
    const updated = this.decode(binding, await this.transport.request(binding, "PATCH", `/api/tasks/${encodeURIComponent(id)}`, { pluginPayload }));
    const result = taskSessionMetadata(updated.pluginPayload);
    if (result.working_session_id !== worker || result.issued_by_session_id !== pluginPayload.issued_by_session_id) {
      throw new Error("Invalid Actio session metadata");
    }
  }

  private remoteStatus(status: TaskStatus): string {
    return status === "pending" ? "open" : status === "delegated" ? "in_progress" : status;
  }

  private decode(binding: ActioBinding, response: unknown): ActioWorkflowTask {
    const result = z.object({ task: Task }).safeParse(response);
    if (!result.success) throw new Error("Invalid Actio task response");
    return this.scoped(binding, result.data.task);
  }

  private scoped(binding: ActioBinding, task: ActioWorkflowTask): ActioWorkflowTask {
    if (task.projectId !== binding.projectId || task.ownerId !== binding.ownerId || !taskTeamInScope(binding, task.teamId)
      || task.source !== ACTIO_WORKFLOW_SOURCE || task.pluginId !== ACTIO_WORKFLOW_SOURCE) {
      throw new Error("Actio task ownership mismatch");
    }
    return task;
  }
}
