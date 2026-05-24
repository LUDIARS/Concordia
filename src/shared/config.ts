/**
 * Concordia runtime config (env loader).
 *
 * 変数群は env-cli を介さず .env 直 load + process.env で読む.
 * Production は systemd 等で env を渡す前提.
 */

import { join } from "node:path";

export interface ConcordiaConfig {
  host: string;
  port: number;
  dbPath: string;
  lostAfterSec: number;
  abandonedAfterSec: number;
  lostPurgeAfterSec: number;
  purgeAfterDays: number;
  sweeperIntervalMs: number;
  anthropicApiKey: string;
  reportModel: string;
  /** AI proposer が新 rule を提案するときの上限. enabled な ai 由来 rule 数が
   *  これ以上なら proposer は claude を呼ばずに skip する (rule 雪だるま防止). */
  maxAiRules: number;
  /**
   * /v1/spawn (および /v1/admin/spawn-session) で body.cwd が省略された時に
   * 使う既定の working directory. 空文字列なら fallback 無し (= 既存挙動、
   * Concordia 自身の cwd になる). LUDIARS の運用では `E:\Document\Ars` を
   * 入れて 「新セッションはまず Ars 配下に開く」 という建付けに揃える.
   * path が存在するかは使う側でチェックしてから適用する.
   */
  spawnDefaultCwd: string;
}

export function loadConfig(env = process.env): ConcordiaConfig {
  return {
    host: env.CONCORDIA_HOST ?? "127.0.0.1",
    port: Number(env.CONCORDIA_PORT ?? "17330"),
    dbPath: env.CONCORDIA_DB_PATH || defaultDbPath(),
    // Stop hook が turn 終わりごとに発火する制約があるので、 idle ≠ session 終了.
    // 30 分 heartbeat 無しで初めて lost にする (元 5 分は短すぎた).
    lostAfterSec: Number(env.CONCORDIA_LOST_AFTER_SEC ?? "1800"),
    abandonedAfterSec: Number(env.CONCORDIA_ABANDONED_AFTER_SEC ?? "86400"),
    lostPurgeAfterSec: Number(env.CONCORDIA_LOST_PURGE_AFTER_SEC ?? "1800"),
    purgeAfterDays: Number(env.CONCORDIA_PURGE_AFTER_DAYS ?? "90"),
    sweeperIntervalMs: Number(env.CONCORDIA_SWEEPER_INTERVAL_MS ?? "60000"),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    reportModel: env.CONCORDIA_REPORT_MODEL ?? "claude-haiku-4-5",
    maxAiRules: Number(env.CONCORDIA_MAX_AI_RULES ?? "10"),
    spawnDefaultCwd: (env.CONCORDIA_SPAWN_DEFAULT_CWD ?? "").trim(),
  };
}

/**
 * 既定の DB 配置. ユーザ home を汚さない方針なので Concordia サービス直下
 * (起動時の cwd) に置く. .gitignore で除外済.
 */
export function defaultDbPath(): string {
  return join(process.cwd(), "concordia.db");
}
