/**
 * 人が承認した M5 計画を適用する (spec/faq/actio-cc-task-project-sync.md §5、spec/feature/task-workflow-v3.md §移行手順)。
 *
 * - create: Actio に作業単位のキーで一度だけ作り (同じキーの task があればそれを使う)、Cc の状態行の
 *   参照 (task_path) を `actio:<id>` に置き換える。
 * - archive: Cc の taskflow に archive の仕組みは無いので、状態行の task_path を `archived:<元の path>`
 *   に置き換える。旧 md の行 (`spec/tasks/*.md`) としても Actio 参照としても読まれなくなり、
 *   接頭辞を外せば元に戻せる。
 *
 * 計画を作った後に行が動いていることがあるので、適用の直前に読んだ現在の行で前提を確かめる。
 * Actio への書き込みと Cc の DB への書き込みは ports に分ける (developer-tools/actio-sync-migration)。
 */
import type { LegacyArchivePlan, LegacyCreatePlan, LegacyTaskPlan } from "./sync-migration-legacy.js";
import type { MigrationStateRow } from "./sync-migration-types.js";

export const ARCHIVED_TASK_PREFIX = "archived:";

export interface LegacyApplyPorts {
  currentRow(repoPath: string, taskPath: string): MigrationStateRow | null;
  /** 作った (または同じキーで既にあった) task の id。作れない理由があれば skip。 */
  createTask(entry: LegacyCreatePlan): Promise<{ id: string; existed: boolean } | { skip: string }>;
  /** 置き換えたら true。置き換え先の行が既にある・元の行が動いた場合は false。 */
  replaceTaskPath(repoPath: string, from: string, to: string, actioTaskId: string | null): boolean;
}

export interface LegacyApplyResult {
  step: "M5";
  task: string;
  op: "create" | "archive";
  result: "applied" | "skipped" | "failed";
  reference?: string;
  existed?: boolean;
  note?: string;
  error?: string;
}

export function archivedTaskPath(taskPath: string): string {
  return `${ARCHIVED_TASK_PREFIX}${taskPath}`;
}

/** 計画時と同じ旧 md の行のままか (状態が変わっていない・まだ Actio に結びついていない)。 */
function premiseHolds(row: MigrationStateRow | null, entry: { status: string }): boolean {
  return !!row && !row.actio_task_id && row.status === entry.status;
}

async function applyCreate(entry: LegacyCreatePlan, ports: LegacyApplyPorts): Promise<LegacyApplyResult> {
  const base = { step: "M5" as const, task: `${entry.repo_path}:${entry.task_path}`, op: "create" as const };
  if (!entry.title || !entry.project) return { ...base, result: "skipped", note: "not_described" };
  if (!premiseHolds(ports.currentRow(entry.repo_path, entry.task_path), entry)) return { ...base, result: "skipped", note: "state_changed" };
  const created = await ports.createTask(entry);
  if ("skip" in created) return { ...base, result: "skipped", note: created.skip };
  const reference = `actio:${created.id}`;
  // Actio 側は作れた (再実行しても同じキーで再利用される)。参照の行が既にあれば重ねて置き換えない。
  if (!ports.replaceTaskPath(entry.repo_path, entry.task_path, reference, created.id)) {
    return { ...base, result: "skipped", reference, existed: created.existed, note: "reference_row_exists" };
  }
  return { ...base, result: "applied", reference, existed: created.existed };
}

function applyArchive(entry: LegacyArchivePlan, ports: LegacyApplyPorts): LegacyApplyResult {
  const base = { step: "M5" as const, task: `${entry.repo_path}:${entry.task_path}`, op: "archive" as const };
  if (!premiseHolds(ports.currentRow(entry.repo_path, entry.task_path), entry)) return { ...base, result: "skipped", note: "state_changed" };
  const reference = archivedTaskPath(entry.task_path);
  if (!ports.replaceTaskPath(entry.repo_path, entry.task_path, reference, null)) {
    return { ...base, result: "skipped", reference, note: "reference_row_exists" };
  }
  return { ...base, result: "applied", reference };
}

/** 失敗は例外で止めず結果として残す (結果ファイルから人が追える)。 */
async function settle(op: "create" | "archive", task: string, attemptLegacyStep: () => Promise<LegacyApplyResult>): Promise<LegacyApplyResult> {
  try { return await attemptLegacyStep(); }
  catch (error) { return { step: "M5", task, op, result: "failed", error: (error as Error).message }; }
}

/** 1 件ずつ適用し、失敗しても次へ進む。 */
export async function applyLegacyPlan(plan: LegacyTaskPlan, ports: LegacyApplyPorts): Promise<LegacyApplyResult[]> {
  const results: LegacyApplyResult[] = [];
  for (const entry of plan.create) {
    results.push(await settle("create", `${entry.repo_path}:${entry.task_path}`, () => applyCreate(entry, ports)));
  }
  for (const entry of plan.archive) {
    results.push(await settle("archive", `${entry.repo_path}:${entry.task_path}`, async () => applyArchive(entry, ports)));
  }
  return results;
}
