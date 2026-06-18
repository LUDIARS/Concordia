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

/**
 * テスト等から platform / existsSync を差し替えるための注入インタフェース。
 * 省略時はそれぞれ `process.platform` / `existsSync` が使われる。
 */
export interface ConfigProbe {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

function autoDetectSpawnDefaultCwd(probe: ConfigProbe = {}): string {
  const platform = probe.platform ?? process.platform;
  const exists = probe.exists ?? existsSync;
  if (platform !== "win32") return "";
  try {
    return exists(LUDIARS_AUTO_DEFAULT_CWD) ? LUDIARS_AUTO_DEFAULT_CWD : "";
  } catch {
    return "";
  }
}

export interface ConcordiaConfig {
  host: string;
  port: number;
  /**
   * admin / sweeper エンドポイントを保護する bearer token (env `CONCORDIA_ADMIN_TOKEN`)。
   *
   * 信頼境界:
   *  - `host` が loopback (127.0.0.1/::1/localhost) のときは従来どおり loopback 信頼境界に
   *    乗り、 token 未設定なら admin API は無認証で使える (空文字列)。
   *  - token を設定すると loopback でも `/v1/admin/*` と `/v1/sweeper/run` は
   *    `Authorization: Bearer <token>` (または `X-Concordia-Admin-Token`) を要求する。
   *  - `host` が非 loopback のときは server.ts が起動時に token 必須を強制する
   *    (未設定なら起動拒否)。 詳細は spec/setup/config-reference.md の信頼境界節。
   */
  adminToken: string;
  dbPath: string;
  lostAfterSec: number;
  abandonedAfterSec: number;
  lostPurgeAfterSec: number;
  purgeAfterDays: number;
  sweeperIntervalMs: number;
  /** 孤児プロセス回収 (reaper) の有効/無効。 env `CONCORDIA_REAPER_ENABLED` (既定 ON)。 */
  reaperEnabled: boolean;
  /** reaper の走査間隔 (ms)。 env `CONCORDIA_REAPER_INTERVAL_MS` (既定 5 分)。 */
  reaperIntervalMs: number;
  /** 起動からこの秒数未満のプロセスは reaper の対象外 (登録レース回避)。 既定 180 秒。 */
  reaperMinAgeSec: number;
  /** ホストメトリクス採取の有効/無効。 env `CONCORDIA_METRICS_ENABLED` (既定 ON)。 */
  metricsEnabled: boolean;
  /** メトリクス採取間隔 (ms)。 env `CONCORDIA_METRICS_INTERVAL_MS` (既定 30 秒)。 */
  metricsIntervalMs: number;
  /** host_metrics の保持時間 (h)。 env `CONCORDIA_METRICS_RETENTION_HOURS` (既定 24)。 */
  metricsRetentionHours: number;
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
   *
   * 複数ルート (`workspaceRoots`) のうち先頭 (= プライマリ)。 Memoria / Lictor
   * 等「単一ルートを前提とする」消費者はこの値を流用する。
   *
   * 実行時は AdminState (schema_meta 永続化 + 設定 GUI) が上書き可能。 ここは既定値。
   */
  workspaceRoot: string;
  /**
   * 走査対象のワークスペースルート群 (= ローカルクローン親の集合)。 先頭が
   * `workspaceRoot` (プライマリ)。 Work ページの repo 走査と Memoria 解決は
   * このリスト全体を対象にする。
   *
   * 解決順:
   *  1. `workspaceRoot` (= CONCORDIA_WORKSPACE_ROOT / 自動既定) を先頭に置く
   *  2. env `CONCORDIA_WORKSPACE_ROOTS` (`;` 区切り) を追加ルートとして連結
   * 正規化パスで重複除去し、 空要素は捨てる。
   *
   * 実行時は AdminState (schema_meta 永続化 + 設定 GUI) が上書き可能。 ここは既定値。
   */
  workspaceRoots: string[];
  /**
   * リポジトリが属する GitHub Organization (例 "LUDIARS")。 PR / repo 操作の
   * owner 解決や delegation 文脈に使う既定値。 env `CONCORDIA_GITHUB_ORG` 優先、
   * 無ければ LUDIARS 運用パスが存在する Windows 機なら "LUDIARS"、 それ以外は空。
   *
   * 実行時は AdminState (schema_meta 永続化 + 設定 GUI) が上書き可能。 ここは既定値。
   */
  githubOrg: string;
}

/** `;` 区切りの追加ワークスペースルート列を trim + 空除去で配列化 (pure)。 */
function parseExtraWorkspaceRoots(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 正規化パスで重複除去しつつ元の表記を保つ (先頭優先、 空は捨てる) (pure)。 */
export function dedupeWorkspaceRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const t = r.trim();
    if (!t) continue;
    const key = t.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * bind host が loopback (= localhost からしか到達できない) かを判定する (pure)。
 *
 * 空 (unset) は既定 bind が `127.0.0.1` なので loopback 扱い。 `0.0.0.0` や `::`、
 * LAN IP / hostname は非 loopback。 IPv6 の角括弧表記 (`[::1]`) も剥がして判定する。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "::1") return true;
  // 127.0.0.0/8 は全て loopback。
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function loadConfig(env = process.env, probe: ConfigProbe = {}): ConcordiaConfig {
  const explicitSpawnCwd = (env.CONCORDIA_SPAWN_DEFAULT_CWD ?? "").trim();
  const spawnDefaultCwd = explicitSpawnCwd || autoDetectSpawnDefaultCwd(probe);
  const githubOrg =
    (env.CONCORDIA_GITHUB_ORG ?? "").trim() ||
    (autoDetectSpawnDefaultCwd(probe) ? "LUDIARS" : "");
  const workspaceRoot = (env.CONCORDIA_WORKSPACE_ROOT ?? "").trim() || spawnDefaultCwd;
  const workspaceRoots = dedupeWorkspaceRoots([
    workspaceRoot,
    ...parseExtraWorkspaceRoots(env.CONCORDIA_WORKSPACE_ROOTS),
  ]);
  return {
    host: env.CONCORDIA_HOST ?? "127.0.0.1",
    port: Number(env.CONCORDIA_PORT ?? "17330"),
    adminToken: (env.CONCORDIA_ADMIN_TOKEN ?? "").trim(),
    dbPath: env.CONCORDIA_DB_PATH || defaultDbPath(),
    // Stop hook が turn 終わりごとに発火する制約があるので、 idle ≠ session 終了.
    // 30 分 heartbeat 無しで初めて lost にする (元 5 分は短すぎた).
    lostAfterSec: Number(env.CONCORDIA_LOST_AFTER_SEC ?? "1800"),
    abandonedAfterSec: Number(env.CONCORDIA_ABANDONED_AFTER_SEC ?? "86400"),
    lostPurgeAfterSec: Number(env.CONCORDIA_LOST_PURGE_AFTER_SEC ?? "1800"),
    purgeAfterDays: Number(env.CONCORDIA_PURGE_AFTER_DAYS ?? "90"),
    sweeperIntervalMs: Number(env.CONCORDIA_SWEEPER_INTERVAL_MS ?? "60000"),
    reaperEnabled: (env.CONCORDIA_REAPER_ENABLED ?? "1") !== "0",
    reaperIntervalMs: Number(env.CONCORDIA_REAPER_INTERVAL_MS ?? "300000"),
    reaperMinAgeSec: Number(env.CONCORDIA_REAPER_MIN_AGE_SEC ?? "180"),
    metricsEnabled: (env.CONCORDIA_METRICS_ENABLED ?? "1") !== "0",
    metricsIntervalMs: Number(env.CONCORDIA_METRICS_INTERVAL_MS ?? "30000"),
    metricsRetentionHours: Number(env.CONCORDIA_METRICS_RETENTION_HOURS ?? "24"),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    reportModel: env.CONCORDIA_REPORT_MODEL ?? "claude-haiku-4-5",
    maxAiRules: Number(env.CONCORDIA_MAX_AI_RULES ?? "10"),
    spawnDefaultCwd,
    workspaceRoot,
    workspaceRoots,
    githubOrg,
  };
}

/**
 * 既定の DB 配置. ユーザ home を汚さない方針なので Concordia サービス直下
 * (起動時の cwd) に置く. .gitignore で除外済.
 */
export function defaultDbPath(): string {
  return join(process.cwd(), "concordia.db");
}
