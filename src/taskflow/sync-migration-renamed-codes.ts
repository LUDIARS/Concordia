/**
 * M2: 改名で消えた code を指すタスクの付け替え (spec/faq/actio-cc-task-project-sync.md §5)。
 * 旧 code → 新 code の対応は Cc の renamed_from と、履歴が残る前の改名を補う手動指定 (`LwP=LP`) から作る。
 */
import type { MigrationActioTask, MigrationProject } from "./sync-migration-types.js";

export interface CodeMove { task: string; from: string; to: string }
export interface RenamedCodePlan { moves: CodeMove[]; unresolved: Array<{ task: string; project_id: string }> }

export function parseManualRenames(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const match = /^([^=\s]+)=([^=\s]+)$/.exec(value.trim());
    if (!match) throw new Error(`invalid rename (expected OLD=NEW): ${value}`);
    result.set(match[1]!, match[2]!);
  }
  return result;
}

export function planRenamedCodes(
  tasks: readonly MigrationActioTask[], projects: readonly MigrationProject[], manual: ReadonlyMap<string, string>,
): RenamedCodePlan {
  const registered = new Set(projects.map((project) => project.code));
  const renamed = new Map<string, string>();
  for (const project of projects) for (const old of project.renamed_from) renamed.set(old, project.code);
  for (const [from, to] of manual) if (registered.has(to)) renamed.set(from, to);
  const plan: RenamedCodePlan = { moves: [], unresolved: [] };
  for (const task of tasks) {
    if (!task.projectId || registered.has(task.projectId)) continue;
    const to = renamed.get(task.projectId);
    if (to) plan.moves.push({ task: `actio:${task.id}`, from: task.projectId, to });
    else plan.unresolved.push({ task: `actio:${task.id}`, project_id: task.projectId });
  }
  return plan;
}
