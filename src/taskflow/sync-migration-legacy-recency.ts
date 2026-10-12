/**
 * M5 の「直近」の判定 (spec/faq/actio-cc-task-project-sync.md §7、neco 2026-10-12)。
 *
 * 旧 md タスクの最終活動時刻は、taskflow の状態行の updated_at を優先し、0 (移行 INSERT のまま)
 * なら md ファイルの git 最終コミット時刻を使う。どちらも無ければ不明として直近に数えない。
 */
import type { MigrationStateRow } from "./sync-migration-types.js";

export const DEFAULT_LEGACY_RECENT_DAYS = 30;
const DAY_MS = 86_400_000;

export interface LegacyActivity { at: number; basis: "state" | "git" }

/** git 最終コミット時刻の表のキー。task_path は区切りを / にそろえる。 */
export function legacyRowKey(repoPath: string, taskPath: string): string {
  return `${repoPath}\0${taskPath.replace(/\\/g, "/")}`;
}

export function legacyActivity(row: MigrationStateRow, commitTimes: ReadonlyMap<string, number>): LegacyActivity | null {
  if (row.updated_at && row.updated_at > 0) return { at: row.updated_at, basis: "state" };
  const committed = commitTimes.get(legacyRowKey(row.repo_path, row.task_path));
  return committed && committed > 0 ? { at: committed, basis: "git" } : null;
}

/** 実行日から recentDays 日以内なら直近。 */
export function recentSince(now: Date, recentDays: number): number {
  return now.getTime() - recentDays * DAY_MS;
}
