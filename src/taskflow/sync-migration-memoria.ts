/**
 * M4: Memoria から取り込んで projectId が空のタスク (spec/faq/actio-cc-task-project-sync.md §5)。
 *
 * category の語を code (大文字小文字を区別) かプロジェクト名 (区別しない) と完全一致で突き合わせる。
 * 一致が 1 つに決まるものだけを候補にし、決まらないものは語を添えて人の判定に回す。
 * done / cancelled は移行しない。
 */
import { isOpenTask, type MigrationActioTask, type MigrationProject } from "./sync-migration-types.js";

export interface MemoriaProjectPlan {
  assign: Array<{ task: string; project: string; matched: string }>;
  unresolved: Array<{ task: string; category: string | null; candidates: string[] }>;
}

export function categoryTerms(category: string | null | undefined): string[] {
  return (category ?? "").split(/[,、，/／・;；\s]+/u).map((term) => term.trim()).filter(Boolean);
}

export function planMemoriaProjects(tasks: readonly MigrationActioTask[], projects: readonly MigrationProject[]): MemoriaProjectPlan {
  const byCode = new Map(projects.map((project) => [project.code, project.code]));
  const byName = new Map(projects.map((project) => [project.project.toLowerCase(), project.code]));
  const plan: MemoriaProjectPlan = { assign: [], unresolved: [] };
  for (const task of tasks) {
    if (task.projectId || !isOpenTask(task) || task.source !== "memoria-import") continue;
    const matches = new Map<string, string>();
    for (const term of categoryTerms(task.category)) {
      const code = byCode.get(term) ?? byName.get(term.toLowerCase());
      if (code) matches.set(code, term);
    }
    if (matches.size === 1) {
      const [[project, matched]] = [...matches];
      plan.assign.push({ task: `actio:${task.id}`, project: project!, matched: matched! });
    } else {
      plan.unresolved.push({ task: `actio:${task.id}`, category: task.category ?? null, candidates: [...matches.keys()].sort() });
    }
  }
  return plan;
}
