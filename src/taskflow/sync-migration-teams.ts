/**
 * M3: プロジェクトにチームがあるのに teamId が空のタスク (spec/faq/actio-cc-task-project-sync.md §5)。
 * チームが 1 つならそのチームに付ける案、複数なら候補だけを並べて人が選ぶ。取り消し済みは対象外。
 */
import type { MigrationActioTask, MigrationProject } from "./sync-migration-types.js";

export interface TeamPlan {
  assign: Array<{ task: string; project: string; team: string }>;
  choose: Array<{ task: string; project: string; candidates: string[] }>;
}

export function planTeamAssignments(tasks: readonly MigrationActioTask[], projects: readonly MigrationProject[]): TeamPlan {
  const teams = new Map(projects.map((project) => [project.code, project.teams]));
  const plan: TeamPlan = { assign: [], choose: [] };
  for (const task of tasks) {
    if (!task.projectId || task.teamId || task.status === "cancelled") continue;
    const candidates = teams.get(task.projectId) ?? [];
    if (candidates.length === 1) plan.assign.push({ task: `actio:${task.id}`, project: task.projectId, team: candidates[0]! });
    else if (candidates.length > 1) plan.choose.push({ task: `actio:${task.id}`, project: task.projectId, candidates: [...candidates] });
  }
  return plan;
}
