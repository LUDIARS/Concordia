/**
 * Actio のスプリント (ActioSprintPort の実装、 契約 v1 §4b)。
 *
 * Concordia の既存 Actio 連携 (CONCORDIA_ACTIO_TASK_BINDINGS + ActioTransport) を通す。
 * - 集計: `GET /api/projects/cc/:code/sprints` (Breviarium の cross-project-sprints と同じ口)
 * - タスク: `GET /api/tasks?scope=all&project=<projectId>&sprint_id=<id>` (ページ送り込み)
 * - 状態: `PATCH /api/tasks/:id {status}`
 *
 * @implements spec/feature/glab-unity-hub.md §4b (GUH-SPRINT)
 */

import { z } from "zod";
import type { ActioBinding } from "../../taskflow/actio-binding.js";
import type { ActioTransport } from "../../taskflow/actio-transport.js";
import { readAllActioTasks } from "../../taskflow/actio-task-pages.js";
import { HubError } from "../domain/protocol.js";
import type { ActioSprintAggregate, SprintTaskRow } from "../domain/sprint-view.js";
import type { ActioSprintPort } from "../application/ports.js";

const Counts = z.record(z.number()).catch({});
const AggregateSchema = z.object({
  project: z.string().catch(""),
  generatedAt: z.string(),
  teams: z.array(z.object({
    teamId: z.string().catch(""),
    teamName: z.string().catch(""),
    activeSprint: z.object({
      id: z.string(),
      name: z.string().catch(""),
      goal: z.string().nullable().catch(null),
      startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((value) => value.slice(0, 10)),
      endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((value) => value.slice(0, 10)),
      tasks: z.object({
        total: z.number().catch(0),
        byStatus: Counts,
        project: z.object({ total: z.number().catch(0), byStatus: Counts }).catch({ total: 0, byStatus: {} }),
      }),
    }).nullable().catch(null),
  }).passthrough()).catch([]),
}).passthrough();

const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.string(),
  assigneeId: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
}).passthrough();

export class ActioSprintClient implements ActioSprintPort {
  constructor(
    private readonly transport: Pick<ActioTransport, "request">,
    /** プロジェクトコード → Actio binding。 */
    private readonly bindingOf: (project: string) => ActioBinding | null,
    private readonly projects: readonly string[],
    private readonly webUrl: string | null,
  ) {}

  async aggregate(project: string): Promise<ActioSprintAggregate> {
    const binding = this.binding(project);
    const raw = await this.call(() => this.transport.request(binding, "GET", `/api/projects/cc/${encodeURIComponent(binding.project)}/sprints`));
    const parsed = AggregateSchema.safeParse(raw);
    if (!parsed.success) throw new HubError("upstream_unavailable", "Actio returned an unexpected sprint aggregate");
    return parsed.data as ActioSprintAggregate;
  }

  async sprintTasks(project: string, sprintId: string): Promise<SprintTaskRow[]> {
    const binding = this.binding(project);
    const query = new URLSearchParams({ scope: "all", project: binding.projectId, sprint_id: sprintId });
    if (binding.teamId) query.set("team_id", binding.teamId);
    const tasks = await this.call(() => readAllActioTasks((path) => this.transport.request(binding, "GET", path), query, TaskSchema));
    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assignee: task.assigneeId ?? null,
      due: task.deadline ?? null,
      url: this.webUrl ? `${this.webUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(task.id)}` : null,
    }));
  }

  async findTask(taskId: string): Promise<{ project: string; assigneeId: string | null } | null> {
    for (const project of this.projects) {
      const binding = this.bindingOf(project);
      if (!binding) continue;
      try {
        const { task } = z.object({ task: TaskSchema.extend({ projectId: z.string().nullable().optional() }) })
          .parse(await this.transport.request(binding, "GET", `/api/tasks/${encodeURIComponent(taskId)}`));
        if (task.projectId && task.projectId !== binding.projectId) continue;
        return { project, assigneeId: task.assigneeId ?? null };
      } catch {
        continue;
      }
    }
    return null;
  }

  async setStatus(project: string, taskId: string, status: string): Promise<void> {
    const binding = this.binding(project);
    await this.call(() => this.transport.request(binding, "PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, { status }));
  }

  private binding(project: string): ActioBinding {
    const binding = this.bindingOf(project);
    if (!binding) throw new HubError("upstream_unavailable", "no Actio binding for this project (CONCORDIA_ACTIO_TASK_BINDINGS)");
    return binding;
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError("upstream_unavailable", "Actio is unavailable");
    }
  }
}
