/**
 * 内部 cron が起動する delegation ジョブの定義一覧。
 *
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
  /**
   * spawn する作業ディレクトリ。 省略するとテンプレート側の `default_cwd` が使われる
   * (caller 指定の cwd は default_cwd より優先されるため、 テンプレに cwd を持たせる
   * ジョブでは必ず省略する)。
   */
  cwd?: string;
}

/** LUDIARS の全リポジトリを横断するジョブの作業ディレクトリ (Ars root)。 */
const ARS_ROOT = "E:\\Document\\Ars";

const DAILY_REVIEW_CRON = "10 5 * * *";

/** 隔週相当 (毎月1日・15日)。croner は隔週を直接表現できないため半月周期で近似する。 */
const AI_NOTE_REVIEW_CRON = "10 6 1,15 * *";

/**
 * Genius (判断カード DB) の ingest。 Genius spec `spec/feature/operations.md` §7 の
 * 「Timer Delegation の実登録」に対応する (テンプレは delegation/seed.ts)。
 *
 * 時刻は既存ジョブ (日次レビュー 5:10 / AI ノートレビュー 6:10) と重ねず、
 * 「Tier 2 夜間 (3:10) → Tier 1 日次 (4:10) → 日次レビュー (5:10)」の順になるよう置く。
 * Tier 2 は全量 run で長時間かかりうるため最も早い枠にし、日次レビューが読む
 * Review/ 系の処理と時間帯が重ならないようにしている。
 */
const GENIUS_INGEST_TIER2_NIGHTLY_CRON = "10 3 * * *";
const GENIUS_INGEST_DAILY_CRON = "10 4 * * *";

/**
 * 依存横断 sweep (テンプレは delegation/seed.ts)。
 *
 * 既存ジョブ (Tier2 3:10 / Tier1 4:10 / 日次レビュー 5:10 / AI ノート 6:10) の後ろに置く。
 * 各リポで npm audit fix → typecheck → build を回すため実行時間が読みにくく、
 * 他ジョブを押し出さないよう最後尾にしている。
 */
const DEPS_SWEEP_CRON = "10 7 * * *";

export const CRON_JOBS: CronJobDefinition[] = [{
    name: "ludiars-review-daily",
    cron: DAILY_REVIEW_CRON,
    call_name: "ludiars-review-daily",
    buildArgs: () => ({ date: todayIso() }),
    cwd: ARS_ROOT,
}, {
    name: "ai-note-biweekly-review",
    cron: AI_NOTE_REVIEW_CRON,
    call_name: "ai-note-biweekly-review",
    buildArgs: () => ({ date: todayIso() }),
    cwd: ARS_ROOT,
}, {
    // Genius ingest は Genius repository で動かす必要があるため cwd を指定せず、
    // テンプレート (delegation/seed.ts) の default_cwd に委ねる。
    name: "genius-ingest-tier2-nightly",
    cron: GENIUS_INGEST_TIER2_NIGHTLY_CRON,
    call_name: "genius-ingest-tier2-nightly",
    buildArgs: () => ({ date: todayIso() }),
}, {
    name: "genius-ingest-daily",
    cron: GENIUS_INGEST_DAILY_CRON,
    call_name: "genius-ingest-daily",
    buildArgs: () => ({ date: todayIso() }),
}, {
    name: "deps-sweep-daily",
    cron: DEPS_SWEEP_CRON,
    call_name: "deps-sweep-daily",
    buildArgs: () => ({ date: todayIso() }),
    cwd: ARS_ROOT,
}];
