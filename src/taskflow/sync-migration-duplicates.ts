/**
 * M1: 委託による重複 task の組 (spec/faq/actio-cc-task-project-sync.md §5)。
 *
 * 同じプロジェクト・同じ branch で未完了の v3 task が複数あれば、引き継ぎで生まれた重複とみなす。
 * 新しい方を正にし、古い方は cancelled + pluginPayload.superseded_by にする案を出す。
 * branch が分からず題名だけが同じ組は、引き継ぎ関係を確かめられないので目視確認の対象にする。
 */
import { isOpenTask, V3_SOURCE, type MigrationActioTask, type MigrationRun } from "./sync-migration-types.js";

export interface DuplicateGroup {
  project: string;
  basis: "branch" | "title";
  key: string;
  keep: string;
  supersede: string[];
  /** 題名だけで組にしたもの。人が引き継ぎ関係を確かめてから適用する。 */
  review_required: boolean;
}

function newestFirst(a: MigrationActioTask, b: MigrationActioTask): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** task ごとの branch。結びついた run のうち最新のものを使う。 */
export function branchByTask(runs: readonly MigrationRun[]): Map<string, string> {
  const result = new Map<string, { branch: string; at: number }>();
  for (const run of runs) {
    const id = run.reference?.startsWith("actio:") ? run.reference.slice("actio:".length) : null;
    if (!id || !run.branch) continue;
    const current = result.get(id);
    if (!current || current.at < run.createdAt) result.set(id, { branch: run.branch, at: run.createdAt });
  }
  return new Map([...result].map(([id, value]) => [id, value.branch]));
}

function groupsBy(
  tasks: readonly MigrationActioTask[], keyOf: (task: MigrationActioTask) => string | null,
): Map<string, MigrationActioTask[]> {
  const groups = new Map<string, MigrationActioTask[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    if (key === null) continue;
    groups.set(key, [...groups.get(key) ?? [], task]);
  }
  return groups;
}

export function planDuplicateMerges(tasks: readonly MigrationActioTask[], runs: readonly MigrationRun[]): DuplicateGroup[] {
  const branches = branchByTask(runs);
  const candidates = tasks.filter((task) => task.source === V3_SOURCE && task.projectId && isOpenTask(task));
  const result: DuplicateGroup[] = [];
  const grouped = new Set<string>();
  const emit = (basis: DuplicateGroup["basis"], groups: Map<string, MigrationActioTask[]>): void => {
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      const [keep, ...older] = [...members].sort(newestFirst);
      for (const member of members) grouped.add(member.id);
      result.push({ project: keep!.projectId!, basis, key, keep: `actio:${keep!.id}`,
        supersede: older.map((task) => `actio:${task.id}`), review_required: basis === "title" });
    }
  };
  emit("branch", groupsBy(candidates, (task) => {
    const branch = branches.get(task.id);
    return branch ? `${task.projectId}\0${branch}` : null;
  }));
  emit("title", groupsBy(candidates.filter((task) => !grouped.has(task.id)),
    (task) => `${task.projectId}\0${task.title.trim()}`));
  return result.map((group) => ({ ...group, key: group.key.replace("\0", " / ") }));
}
