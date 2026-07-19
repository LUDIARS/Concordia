/**
 * 内部 cron が起動する delegation ジョブの定義一覧。
 *
 * 実行は src/scheduler/cron-scheduler.ts が担う。日次レビューは二重起動を避けるため、
 * env で選択した delegation だけを登録する。
 */

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface CronJobDefinition {
  /** ログ・triggered_by 用の識別名 (delegation の call_name とは独立) */
  name: string;
  /** croner 記法の cron 式 (分 時 日 月 曜日) */
  cron: string;
  /** invoke する delegation template の call_name */
  call_name: string;
  /** invoke 時の args を都度生成する (日付など実行時点の値を含められるように) */
  buildArgs: () => Record<string, unknown>;
}

export const DAILY_REVIEW_DELEGATION_CALL_NAMES = [
  "ludiars-review-daily-dual",
  "ludiars-review-daily",
] as const;

export type DailyReviewDelegationCallName = typeof DAILY_REVIEW_DELEGATION_CALL_NAMES[number];

const DEFAULT_DAILY_REVIEW_DELEGATION: DailyReviewDelegationCallName = "ludiars-review-daily-dual";
const DAILY_REVIEW_CRON = "10 5 * * *";

export function resolveDailyReviewDelegation(raw: string | undefined): DailyReviewDelegationCallName {
  const selected = raw?.trim() || DEFAULT_DAILY_REVIEW_DELEGATION;
  if (DAILY_REVIEW_DELEGATION_CALL_NAMES.includes(selected as DailyReviewDelegationCallName)) {
    return selected as DailyReviewDelegationCallName;
  }
  throw new Error(
    `CONCORDIA_DAILY_REVIEW_DELEGATION must be one of: ${DAILY_REVIEW_DELEGATION_CALL_NAMES.join(", ")}`,
  );
}

export function createCronJobs(env: NodeJS.ProcessEnv = process.env): CronJobDefinition[] {
  const callName = resolveDailyReviewDelegation(env.CONCORDIA_DAILY_REVIEW_DELEGATION);
  return [{
    name: callName,
    cron: DAILY_REVIEW_CRON,
    call_name: callName,
    buildArgs: () => ({ date: todayIso() }),
  }];
}

export const CRON_JOBS: CronJobDefinition[] = createCronJobs();
