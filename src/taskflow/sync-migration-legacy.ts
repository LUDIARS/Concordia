/**
 * M5: Cc にしか無い旧 md タスク (spec/tasks/*.md) の移行計画 (spec/faq/actio-cc-task-project-sync.md §5・§7)。
 *
 * neco 判断 2026-10-12「pending のうち直近だけ移す」: 最終活動時刻 (sync-migration-legacy-recency.ts) が
 * 直近の pending / delegated だけを、作業単位のキー `work:<repoKey>:<path>` で Actio に一度だけ作る案にする。
 * 直近でない pending / delegated と、それ以外の状態 (done など) は archive の候補として並べる。
 */
import { repositoryKey } from "./actio-binding.js";
import { DEFAULT_LEGACY_RECENT_DAYS, legacyActivity, recentSince } from "./sync-migration-legacy-recency.js";
import type { MigrationStateRow } from "./sync-migration-types.js";

export interface LegacyCreatePlan {
  repo_path: string;
  task_path: string;
  status: string;
  source_ref: string;
  subsidiary_id: string | null;
  activity_at: string;
  activity_basis: "state" | "git";
  /** dry-run が binding と md から決めた値 (sync-migration-legacy-describe.ts)。apply はこれを作る。 */
  title?: string;
  project?: string;
  team?: string | null;
}

export interface LegacyArchivePlan {
  repo_path: string;
  task_path: string;
  status: string;
  /** closed: pending / delegated 以外。inactive: 直近でない。no_activity: 最終活動時刻が分からない。 */
  reason: "closed" | "inactive" | "no_activity";
  activity_at: string | null;
}

export interface LegacyTaskPlan {
  recent_days: number;
  recent_since: string;
  create: LegacyCreatePlan[];
  archive: LegacyArchivePlan[];
  /** Actio の作り先が決まらないもの。作らず archive もせず、人が判断する。 */
  unbound: Array<{ repo_path: string; task_path: string; reason: string }>;
}

export interface LegacyPlanOptions {
  now: Date;
  recentDays?: number;
  /** legacyRowKey → md ファイルの git 最終コミット時刻 (epoch ms)。 */
  commitTimes?: ReadonlyMap<string, number>;
}

const LEGACY_TASK_PATH = /^spec\/tasks\/.+\.md$/;
const ACTIVE = new Set(["pending", "delegated"]);

export function isLegacyTaskRow(row: MigrationStateRow): boolean {
  return !row.actio_task_id && LEGACY_TASK_PATH.test(row.task_path.replace(/\\/g, "/"));
}

export function planLegacyTasks(rows: readonly MigrationStateRow[], options: LegacyPlanOptions): LegacyTaskPlan {
  const recentDays = options.recentDays ?? DEFAULT_LEGACY_RECENT_DAYS;
  const since = recentSince(options.now, recentDays);
  const commitTimes = options.commitTimes ?? new Map<string, number>();
  const plan: LegacyTaskPlan = {
    recent_days: recentDays, recent_since: new Date(since).toISOString(), create: [], archive: [], unbound: [],
  };
  for (const row of rows) {
    if (!isLegacyTaskRow(row)) continue;
    const path = row.task_path.replace(/\\/g, "/");
    const activity = legacyActivity(row, commitTimes);
    const activityAt = activity ? new Date(activity.at).toISOString() : null;
    if (ACTIVE.has(row.status) && activity && activity.at >= since) {
      plan.create.push({ repo_path: row.repo_path, task_path: path, status: row.status,
        source_ref: `work:${repositoryKey(row.repo_path)}:${path}`, subsidiary_id: row.subsidiary_id ?? null,
        activity_at: activityAt!, activity_basis: activity.basis });
      continue;
    }
    const reason = !ACTIVE.has(row.status) ? "closed" : activity ? "inactive" : "no_activity";
    plan.archive.push({ repo_path: row.repo_path, task_path: path, status: row.status, reason, activity_at: activityAt });
  }
  return plan;
}
