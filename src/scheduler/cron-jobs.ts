/**
 * 内部 cron が起動する delegation ジョブの定義一覧。
 *
 * DB 化・GUI 化はしない — 既存の morning/daily/stat scheduler と同じく
 * コード内の固定リストで管理する (対象が増えて可変管理が要るようになったら再検討)。
 * 実行は src/scheduler/cron-scheduler.ts が担う。
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

export const CRON_JOBS: CronJobDefinition[] = [
  {
    name: "ludiars-review-daily",
    // 毎日 5:07 JST。 旧 Windows Task Scheduler / claude.ai リモートルーティンの
    // 起動時刻慣行 (5:07) を踏襲。
    // 新方式 (daily-review-reconciliation) の安定確認後に停止予定
    // (LUDIARS/docs/REVIEW-STRATEGY.md §7 O2 — 移行完了までは並走)。
    cron: "7 5 * * *",
    call_name: "ludiars-review-daily",
    buildArgs: () => ({ date: todayIso() }),
  },
  {
    name: "daily-review-reconciliation",
    // 毎日 5:10 JST。 Codex × Opus の独立差分レビュー + 突合 (Tier 1 リポのみ)。
    // 対象・手順の正本は LUDIARS/service-map.json + LUDIARS/docs/REVIEW-PROMPTS.md。
    cron: "10 5 * * *",
    call_name: "daily-review-reconciliation",
    buildArgs: () => ({ date: todayIso() }),
  },
];
