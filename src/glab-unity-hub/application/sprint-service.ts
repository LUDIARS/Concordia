/**
 * テルプシコラ (スプリント) の use case (契約 v1 §4b `sprint.current` / `sprint.tasks.update`)。
 *
 * 正本は Actio。 状態変更は担当者が本人のタスクだけ (Discord ユーザー → Actio ユーザーの
 * 対応は設定 `glabUnityHub.actioUsers`)。 対応が無い人は変更できない。
 *
 * @implements spec/feature/glab-unity-hub.md §4b (GUH-SPRINT)
 */

import { HubError } from "../domain/protocol.js";
import { buildSprintView, currentActiveSprint, mayUpdateSprintTask, type SprintCurrentView } from "../domain/sprint-view.js";
import type { HubPayload } from "../domain/methods.js";
import type { ActioSprintPort, AuditLog } from "./ports.js";
import type { MethodContext } from "./method-context.js";

export interface SprintServiceDeps {
  readonly actio: ActioSprintPort;
  readonly projects: readonly string[];
  /** Discord ユーザー id → Actio ユーザー id。 */
  readonly actioUserOf: (discordUserId: string) => string | null;
  readonly audit: AuditLog;
}

export class HubSprintService {
  constructor(private readonly deps: SprintServiceDeps) {}

  async current(_context: MethodContext, payload: HubPayload<"sprint.current">): Promise<SprintCurrentView> {
    this.requireProject(payload.project);
    const aggregate = await this.deps.actio.aggregate(payload.project);
    const sprint = currentActiveSprint(aggregate);
    const tasks = sprint ? await this.deps.actio.sprintTasks(payload.project, sprint.id) : [];
    return buildSprintView({ project: payload.project, aggregate, tasks });
  }

  async updateTask(context: MethodContext, payload: HubPayload<"sprint.tasks.update">): Promise<{ taskId: string; status: string }> {
    const task = await this.deps.actio.findTask(payload.taskId);
    if (!task) throw new HubError("not_found", "task not found in configured projects");
    const actor = context.identity.token.discordUserId;
    if (!mayUpdateSprintTask(task, this.deps.actioUserOf(actor))) {
      this.deps.audit.record({
        kind: "operation", tokenId: context.identity.token.id, discordUserId: actor, country: null, ip: null,
        operation: "sprint.tasks.update", result: "forbidden", detail: payload.taskId,
      });
      throw new HubError("forbidden", "only the assignee can change this task");
    }
    await this.deps.actio.setStatus(task.project, payload.taskId, payload.status);
    return { taskId: payload.taskId, status: payload.status };
  }

  private requireProject(project: string): void {
    if (!this.deps.projects.includes(project)) throw new HubError("not_found", "project is not configured for GLab-UnityHub");
  }
}
