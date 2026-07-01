/**
 * Concordia runtime config (env loader).
 *
 * 変数群は env-cli を介さず .env 直 load + process.env で読む.
 * Production は systemd 等で env を渡す前提.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * LUDIARS ワークスペースルート (= ローカルクローンの親ディレクトリ) の解決。
 *
 * 正本は Excubitor が spawn 時にプロセス env として注入する `LUDIARS_ROOT`
 * (Excubitor 側 `arsRoot()` = env `EXCUBITOR_ARS_ROOT` / `LUDIARS_ROOT` → cwd 親 で解決した値)。
 * 旧実装は `E:\Document\Ars` を直書きして「存在すれば採用」 していたが、 別ドライブ
 * (D:\LUDIARS) のマシンで全パスが壊れるため、 ドライブの焼き込みを廃止し注入 env を基準にする。
 * `.env` ファイルには依存しない (プロセス env のみ)。
 *
 * 未注入 (env 無し) なら空文字列を返す (= フォールバック無し)。 実行時は AdminState の上書き、
 * あるいは明示 env CONCORDIA_SPAWN_DEFAULT_CWD / CONCORDIA_WORKSPACE_ROOT が効く。
 */
function resolveLudiarsRoot(env: NodeJS.ProcessEnv): string {
  return (env.LUDIARS_ROOT ?? "").trim();
}

/**
 * テスト等から existsSync を差し替えるための注入インタフェース。
 * 省略時は `existsSync` が使われる。
 */
export interface ConfigProbe {
  exists?: (path: string) => boolean;
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
  /**
   * ended_at がこの秒数以内の ended セッションは reaper の回収対象外 (live 扱い)。
   * session-end スキル実行中に reaper が割り込んで WT を kill する事故を防ぐ安全弁。
   * env `CONCORDIA_REAPER_ENDED_GRACE_SEC` (既定 300 = 5 分)。 0 で無効。
   */
  reaperEndedGraceSec: number;
  /** 停止セッションの続行 nudge の有効/無効。 env `CONCORDIA_STALL_NUDGE_ENABLED` (既定 ON)。 */
  stallNudgeEnabled: boolean;
  /** 停止 nudge の走査間隔 (ms)。 env `CONCORDIA_STALL_NUDGE_INTERVAL_MS` (既定 10 分)。 */
  stallNudgeIntervalMs: number;
  /** transcript 無更新がこの秒数を超えたら「停止」 とみなす。 env `CONCORDIA_STALL_IDLE_SEC` (既定 3600=1h)。 */
  stallIdleSec: number;
  /** 一度 nudge したら次まで空ける秒数。 env `CONCORDIA_STALL_NUDGE_COOLDOWN_SEC` (既定 stallIdleSec と同じ)。 */
  stallNudgeCooldownSec: number;
  /** ホストメトリクス採取の有効/無効。 env `CONCORDIA_METRICS_ENABLED` (既定 ON)。 */
  metricsEnabled: boolean;
  /** メトリクス採取間隔 (ms)。 env `CONCORDIA_METRICS_INTERVAL_MS` (既定 30 秒)。 */
  metricsIntervalMs: number;
  /** host_metrics の保持時間 (h)。 env `CONCORDIA_METRICS_RETENTION_HOURS` (既定 24)。 */
  metricsRetentionHours: number;
  /**
   * 中央チャット描画の renderer。 env `CONCORDIA_CHAT_RENDERER`。
   * "cli" | "template"。 空 ("") なら "cli" (claude -p サブスク Haiku)。
   * LUDIARS は API 不使用のため Anthropic API 直叩きは廃止。
   */
  chatRenderer: string;
  /**
   * 中央チャット描画のモデル。 env `CONCORDIA_CHAT_MODEL`。 空なら "haiku"。
   */
  chatModel: string;
  /**
   * /v1/spawn (および /v1/admin/spawn-session) で body.cwd が省略された時に
   * 使う既定の working directory.
   *
   * 解決順:
   *  1. env `CONCORDIA_SPAWN_DEFAULT_CWD` (明示指定、 最優先)
   *  2. env `LUDIARS_ROOT` (Excubitor が spawn 時に注入する LUDIARS ワークスペースルート)
   *  3. 空文字列 (= フォールバック無し、 Concordia 自身の cwd で spawn)
   *
   * 空文字列なら spawn endpoint は cwd を指定せず spawnSession 側のロジックで
   * `process.cwd()` 相当を使う.
   */
  spawnDefaultCwd: string;
  /**
   * ローカルクローンを並べた作業ルート (Work ページの repo 一覧の走査先)。
   * env `CONCORDIA_WORKSPACE_ROOT` 優先、 無ければ spawnDefaultCwd を流用
   * (= LUDIARS_ROOT)。 空なら Work の repo 一覧は空になる。
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

/**
 * concordia.config.json の `server` ブロックを読む。 host / port の既定値はここ
 * (env は override 用)。 ファイルが無ければ空 (= ハードコード既定にフォール) を返すが、
 * ファイルが在って壊れている (JSON parse 失敗) ときは握りつぶさず即 throw する
 * (無言フォールバック禁止 / RULE §7.1)。
 */
export function loadServerFileConfig(probe: ConfigProbe = {}): { host?: string; port?: number } {
  const exists = probe.exists ?? existsSync;
  const path = join(process.cwd(), "concordia.config.json");
  if (!exists(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    server?: { host?: unknown; port?: unknown };
  };
  const host = typeof raw?.server?.host === "string" ? raw.server.host : undefined;
  const port = typeof raw?.server?.port === "number" ? raw.server.port : undefined;
  return { host, port };
}

export function loadConfig(env = process.env, probe: ConfigProbe = {}): ConcordiaConfig {
  const file = loadServerFileConfig(probe);
  const explicitSpawnCwd = (env.CONCORDIA_SPAWN_DEFAULT_CWD ?? "").trim();
  // 作業ディレクトリの既定は Excubitor 注入の LUDIARS_ROOT を基準にする (ドライブ非依存)。
  const ludiarsRoot = resolveLudiarsRoot(env);
  const spawnDefaultCwd = explicitSpawnCwd || ludiarsRoot;
  const githubOrg =
    (env.CONCORDIA_GITHUB_ORG ?? "").trim() ||
    (ludiarsRoot ? "LUDIARS" : "");
  const workspaceRoot = (env.CONCORDIA_WORKSPACE_ROOT ?? "").trim() || spawnDefaultCwd;
  const workspaceRoots = dedupeWorkspaceRoots([
    workspaceRoot,
    ...parseExtraWorkspaceRoots(env.CONCORDIA_WORKSPACE_ROOTS),
  ]);
  return {
    // 既定値は concordia.config.json (env は override 用)。 env を使わない方針。
    host: env.CONCORDIA_HOST ?? file.host ?? "127.0.0.1",
    port: Number(env.CONCORDIA_PORT ?? file.port ?? 11111),
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
    reaperEndedGraceSec: Number(env.CONCORDIA_REAPER_ENDED_GRACE_SEC ?? "300"),
    stallNudgeEnabled: (env.CONCORDIA_STALL_NUDGE_ENABLED ?? "1") !== "0",
    stallNudgeIntervalMs: Number(env.CONCORDIA_STALL_NUDGE_INTERVAL_MS ?? "600000"),
    stallIdleSec: Number(env.CONCORDIA_STALL_IDLE_SEC ?? "3600"),
    stallNudgeCooldownSec: Number(
      env.CONCORDIA_STALL_NUDGE_COOLDOWN_SEC ?? env.CONCORDIA_STALL_IDLE_SEC ?? "3600",
    ),
    metricsEnabled: (env.CONCORDIA_METRICS_ENABLED ?? "1") !== "0",
    metricsIntervalMs: Number(env.CONCORDIA_METRICS_INTERVAL_MS ?? "30000"),
    metricsRetentionHours: Number(env.CONCORDIA_METRICS_RETENTION_HOURS ?? "24"),
    chatRenderer: env.CONCORDIA_CHAT_RENDERER ?? "",
    chatModel: env.CONCORDIA_CHAT_MODEL ?? "",
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
