/**
 * M5 で作る task の作り先と題名を決める (spec/faq/actio-cc-task-project-sync.md §5)。
 *
 * 作り先は委託と同じ Actio binding の規則 (actio-project-binding.ts: 明示の binding、無ければ repo の
 * プロジェクトコードと Actio の登録の完全一致、チームは 1 つならそれ・複数なら team-less) で決まった
 * binding のうち、その repo の本社 binding をそのまま使う。題名は CC-TF-SYNC-04 の規則で md から作る。
 * 決まらないものは unbound に回し、作らず archive もしない。
 */
import { repositoryKey, type ActioBinding } from "./actio-binding.js";
import type { LegacyCreatePlan, LegacyTaskPlan } from "./sync-migration-legacy.js";

/** md から読んだ task の中身 (developer-tools の reader が返す)。 */
export interface LegacyTaskContent {
  title: string;
  body: string;
  kind: string;
  memoryLinks: string[];
}

export type LegacyBindingResult = { ok: true; binding: ActioBinding } | { ok: false; reason: string };

export function bindingForRepo(bindings: readonly ActioBinding[], repoPath: string, subsidiaryId: string | null): LegacyBindingResult {
  // 子会社の行は子会社の binding と会社の照合が要る。移行は本社の行だけを扱う。
  if (subsidiaryId) return { ok: false, reason: "subsidiary_task" };
  const key = repositoryKey(repoPath);
  const matches = bindings.filter((binding) => binding.subsidiaryId === null && repositoryKey(binding.repoPath) === key);
  if (matches.length === 0) return { ok: false, reason: "no_actio_binding" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous_actio_binding" };
  return { ok: true, binding: matches[0]! };
}

/** create の各行に作り先と題名を書き込む。決まらない行は unbound へ移す。 */
export function describeLegacyPlan(
  plan: LegacyTaskPlan, bindings: readonly ActioBinding[],
  readContent: (repoPath: string, taskPath: string) => LegacyTaskContent | null,
): LegacyTaskPlan {
  const create: LegacyCreatePlan[] = [];
  const unbound = [...plan.unbound];
  for (const entry of plan.create) {
    const resolved = bindingForRepo(bindings, entry.repo_path, entry.subsidiary_id);
    const content = resolved.ok ? readContent(entry.repo_path, entry.task_path) : null;
    if (!resolved.ok || !content) {
      unbound.push({ repo_path: entry.repo_path, task_path: entry.task_path, reason: resolved.ok ? "md_missing" : resolved.reason });
      continue;
    }
    create.push({ ...entry, title: content.title, project: resolved.binding.projectId, team: resolved.binding.teamId });
  }
  return { ...plan, create, unbound };
}
