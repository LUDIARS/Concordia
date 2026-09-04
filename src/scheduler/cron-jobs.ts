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

/**
 * 1 回の発火を対象ごとの複数 invoke へ展開する戦略名。 対象の列挙は DB を触るため
 * この定義ファイルでは持たず、 cron-scheduler の `fanoutResolvers` が解決する。
 */
export type CronJobFanout = "teams";

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
  /**
   * 指定すると 1 回の発火で対象ごとに invoke する (例: チームごとの朝礼)。
   * 対象が 0 件なら 1 度も invoke しない。
   */
  fanout?: CronJobFanout;
}

/** LUDIARS の全リポジトリを横断するジョブの作業ディレクトリ (Ars root)。 */
const ARS_ROOT = "E:\\Document\\Ars";

/** LUDIARS 公開サービスダッシュボードの日報更新。毎日 3:00 JST。 */
const LUDIARS_STATUS_DAILY_CRON = "0 3 * * *";

/**
 * 週次レビュー (2026-08-08 neco 指示で毎日 → 週次へ変更)。 毎週月曜 4:40 JST。
 * 空いた毎朝 5:10 枠には脆弱性対応パートタイマーを新設した (VULNERABILITY_RESPONSE_CRON)。
 */
const WEEKLY_REVIEW_CRON = "40 4 * * 1";

/** 毎朝の脆弱性対応。 旧デイリーレビューの 5:10 枠を引き継ぐ (2026-08-08 neco 指示)。 */
const VULNERABILITY_RESPONSE_CRON = "10 5 * * *";

/** 隔週相当 (毎月1日・15日)。croner は隔週を直接表現できないため半月周期で近似する。 */
const AI_NOTE_REVIEW_CRON = "10 6 1,15 * *";

const DEPS_SWEEP_DAILY_CRON = "10 7 * * *";

/** Steam persona source collection. Discutere's STEAM-PERSONA.md defines the pipeline. */
const STEAM_PERSONA_DAILY_CRON = "40 7 * * *";

/** Vultus external actress catalogs: scan all syllabary pages and ingest only deltas. */
const VULTUS_CATALOG_REFRESH_DAILY_CRON = "20 8 * * *";

/**
 * Genius (判断カード DB) の ingest。 Genius spec `spec/feature/operations.md` §7 の
 * 「Timer Delegation の実登録」に対応する (テンプレは delegation/seed.ts)。
 *
 * Tier 2 の夜間 ingest は 2026-08-13 に歩留まり不足のため停止した。
 * テンプレートは再開に備えて残すが cron には登録しない。Tier 1 は既存ジョブ
 * (脆弱性対応 5:10 / AI ノートレビュー 6:10) と重ならない 4:10 に実行する。
 */
const GENIUS_INGEST_DAILY_CRON = "10 4 * * *";

/** カイゼン (2026-08-08 neco 指示で新設)。 毎朝 9:00 JST、前日の session-logs とメモリを棚卸しして改善提案する。 */
const KAIZEN_CRON = "0 9 * * *";

/**
 * 月末の請求書作成。 croner の `L` (day-of-month) で 28〜31 日の揺れを吸収する。
 * 当月分を締めてから作るので、 朝に固まっている他ジョブとは離して 18:10 JST に置く。
 */
const QUAESTOR_INVOICE_MONTHLY_CRON = "10 18 L * *";

/** メール監視パートタイマー。朝/昼/夕の 3 回 (JST)。他ジョブの固まる朝枠 (3:00〜9:00) を避ける。 */
const QUAESTOR_MAIL_SWEEP_CRON = "40 9,12,18 * * *";

/** Gmail users.watch は 7 日で失効するため、6 日分の余裕を残して毎朝更新する。 */
const QUAESTOR_MAIL_WATCH_RENEW_CRON = "20 4 * * *";

const JST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

type QuaestorMailSweepArgs = {
  slot: "morning" | "noon" | "evening";
  date: string;
};

export function buildQuaestorMailSweepArgs(now: Date = new Date()): QuaestorMailSweepArgs {
  const parts = Object.fromEntries(
    JST_DATE_TIME_FORMATTER.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const hour = Number(parts.hour);
  const slot = hour < 12 ? "morning" : hour < 18 ? "noon" : "evening";
  return { slot, date: `${parts.year}-${parts.month}-${parts.day}` };
}

// チーム朝礼 / 定例 / 課題スカウト / タスク整理の teams fanout 4 本は 2026-09-01 neco 指示
// (「チームはチーム内で spawn するだけにする」) で廃止した。 チームの定時ジョブは持たず、
// 巡回由来の装置は散歩セッション (spec/feature/curiosity-walk.md) だけを残す。
export const CRON_JOBS: CronJobDefinition[] = [{
    name: "ludiars-status-daily",
    cron: LUDIARS_STATUS_DAILY_CRON,
    call_name: "ludiars-status-daily",
    buildArgs: () => ({ date: todayIso() }),
}, {
    name: "ludiars-review-weekly",
    cron: WEEKLY_REVIEW_CRON,
    call_name: "ludiars-review-weekly",
    buildArgs: () => ({ date: todayIso() }),
    cwd: ARS_ROOT,
}, {
    name: "vulnerability-response-daily",
    cron: VULNERABILITY_RESPONSE_CRON,
    call_name: "vulnerability-response-daily",
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
    name: "genius-ingest-daily",
    cron: GENIUS_INGEST_DAILY_CRON,
    call_name: "genius-ingest-daily",
    buildArgs: () => ({ date: todayIso() }),
}, {
    name: "deps-sweep-daily",
    cron: DEPS_SWEEP_DAILY_CRON,
    call_name: "deps-sweep-daily",
    buildArgs: () => ({}),
    cwd: ARS_ROOT,
}, {
    // Discutere で動かす必要があるため cwd はテンプレートの default_cwd に委ねる。
    name: "steam-persona-daily",
    cron: STEAM_PERSONA_DAILY_CRON,
    call_name: "steam-persona-daily",
    buildArgs: () => ({ date: todayIso() }),
}, {
    // Vultus 本体で実行するため cwd はテンプレートの default_cwd に委ねる。
    name: "vultus-catalog-refresh-daily",
    cron: VULTUS_CATALOG_REFRESH_DAILY_CRON,
    call_name: "vultus-catalog-refresh-daily",
    buildArgs: () => ({ date: todayIso() }),
}, {
    // Quaestor 本体で実行するため cwd はテンプレートの default_cwd に委ねる。
    name: "quaestor-invoice-monthly",
    cron: QUAESTOR_INVOICE_MONTHLY_CRON,
    call_name: "quaestor-invoice-monthly",
    buildArgs: () => {
      const now = new Date();
      return { month: `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}` };
    },
}, {
    // Quaestor 本体で実行するため cwd はテンプレートの default_cwd に委ねる。
    name: "quaestor-mail-sweep",
    cron: QUAESTOR_MAIL_SWEEP_CRON,
    call_name: "quaestor-mail-sweep",
    buildArgs: () => buildQuaestorMailSweepArgs(),
}, {
    // Quaestor 本体で実行するため cwd はテンプレートの default_cwd に委ねる。
    name: "quaestor-mail-watch-renew",
    cron: QUAESTOR_MAIL_WATCH_RENEW_CRON,
    call_name: "quaestor-mail-watch-renew",
    buildArgs: () => ({}),
}, {
    name: "kaizen-daily",
    cron: KAIZEN_CRON,
    call_name: "kaizen-daily",
    buildArgs: () => ({ date: todayIso() }),
    cwd: ARS_ROOT,
}];
