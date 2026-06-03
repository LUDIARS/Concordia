/**
 * Concordia runtime config (env loader).
 *
 * 変数群は env-cli を介さず .env 直 load + process.env で読む.
 * Production は systemd 等で env を渡す前提.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * spawnDefaultCwd の自動既定値. LUDIARS の運用パス (E:\Document\Ars) が
 * 存在する Windows 機なら自動で採用する. env override (CONCORDIA_SPAWN_DEFAULT_CWD)
 * が最優先で、 ここでは env が unset/空 の場合に限り評価する.
 *
 * Linux/macOS や該当パスを持たない Windows 機では空のまま (= フォールバック無し、
 * Concordia 自身の cwd で spawn) を返すので、 open-source 環境を壊さない.
 */
const LUDIARS_AUTO_DEFAULT_CWD = "E:\\Document\\Ars";

function autoDetectSpawnDefaultCwd(): string {
  if (process.platform !== "win32") return "";
  try {
    return existsSync(LUDIARS_AUTO_DEFAULT_CWD) ? LUDIARS_AUTO_DEFAULT_CWD : "";
  } catch {
    return "";
  }
}

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
   * 使う既定の working directory.
   *
   * 解決順:
   *  1. env `CONCORDIA_SPAWN_DEFAULT_CWD` (明示指定、 最優先)
   *  2. `E:\Document\Ars` が存在する Windows 機ならその値 (LUDIARS 運用既定)
   *  3. 空文字列 (= フォールバック無し、 Concordia 自身の cwd で spawn)
   *
   * 空文字列なら spawn endpoint は cwd を指定せず spawnSession 側のロジックで
   * `process.cwd()` 相当を使う.
   */
  spawnDefaultCwd: string;
  /**
   * ローカルクローンを並べた作業ルート (Work ページの repo 一覧の走査先)。
   * env `CONCORDIA_WORKSPACE_ROOT` 優先、 無ければ spawnDefaultCwd を流用
   * (LUDIARS では E:\Document\Ars)。 空なら Work の repo 一覧は空になる。
   */
  workspaceRoot: string;
}

export function loadConfig(env = process.env): ConcordiaConfig {
  const explicitSpawnCwd = (env.CONCORDIA_SPAWN_DEFAULT_CWD ?? "").trim();
  const spawnDefaultCwd = explicitSpawnCwd || autoDetectSpawnDefaultCwd();
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
    spawnDefaultCwd,
    workspaceRoot: (env.CONCORDIA_WORKSPACE_ROOT ?? "").trim() || spawnDefaultCwd,
  };
}

/**
 * 既定の DB 配置. ユーザ home を汚さない方針なので Concordia サービス直下
 * (起動時の cwd) に置く. .gitignore で除外済.
 */
export function defaultDbPath(): string {
  return join(process.cwd(), "concordia.db");
}
