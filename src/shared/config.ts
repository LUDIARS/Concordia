/**
 * Concordia runtime config (env loader).
 *
 * 変数群は env-cli を介さず .env 直 load + process.env で読む.
 * Production は systemd 等で env を渡す前提.
 */

export interface ConcordiaConfig {
  host: string;
  port: number;
  dbPath: string;
  lostAfterSec: number;
  abandonedAfterSec: number;
  purgeAfterDays: number;
  sweeperIntervalMs: number;
  anthropicApiKey: string;
  reportModel: string;
}

export function loadConfig(env = process.env): ConcordiaConfig {
  return {
    host: env.CONCORDIA_HOST ?? "127.0.0.1",
    port: Number(env.CONCORDIA_PORT ?? "17330"),
    dbPath: env.CONCORDIA_DB_PATH || "",
    lostAfterSec: Number(env.CONCORDIA_LOST_AFTER_SEC ?? "300"),
    abandonedAfterSec: Number(env.CONCORDIA_ABANDONED_AFTER_SEC ?? "86400"),
    purgeAfterDays: Number(env.CONCORDIA_PURGE_AFTER_DAYS ?? "90"),
    sweeperIntervalMs: Number(env.CONCORDIA_SWEEPER_INTERVAL_MS ?? "60000"),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    reportModel: env.CONCORDIA_REPORT_MODEL ?? "claude-haiku-4-5",
  };
}
