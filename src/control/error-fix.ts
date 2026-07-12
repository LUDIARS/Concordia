/**
 * エラー自動修正ディスパッチャ (error.reported → 常駐 error-fixer Codex に修正依頼).
 *
 * 方針 (2026-06-01 ユーザ決定):
 *  - 対象: フィルタあり — vestigium:* (サービスの実エラー) 主体 + discord の非一過性失敗。
 *    discord の rate-limit / timeout / unavailable 等の一過性は除外。
 *  - セッション: 単一の常駐 Codex を再利用。 同定キーは「専用 cwd の active codex-cli セッション」。
 *    cwd は CONCORDIA_ERROR_AUTOFIX_CWD (= fixer の identity)。 居なければ一度だけ spawn。
 *  - 安全弁: env CONCORDIA_ERROR_AUTOFIX=1 の時だけ稼働 (既定 OFF)。 dedupe + rate-limit。
 *    修正手順は「ブランチ→PR→CI green なら自動マージまで」 (Ars 自動マージ規約) を prompt で指示。
 *
 * inject は session.inject event (Lictor が WS 経由で Codex TUI に流し込む) を使う
 * — auto-session-end-inject.ts と同じ経路。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { spawnSession } from "./spawner.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("error-fix");

export const ERROR_FIX_INJECT_SOURCE = "error-autofix";

const DEDUPE_SEC = 10 * 60; // 同一エラーは 10 分以内なら再依頼しない
const MIN_INJECT_INTERVAL_SEC = 120; // Codex を thrash させない最小間隔
const SPAWN_COOLDOWN_SEC = 120; // fixer spawn の連打防止
const MAX_QUEUE = 20;

/**
 * source/message から「Codex に修正させるべきエラーか」 を判定する.
 *  - vestigium:* は対象 (サービスの実エラー)
 *  - discord:* は一過性 (rate limit / timeout / unavailable / 4xx-5xx の瞬断) を除外
 *  - error-autofix 由来 (fixer 自身) は対象外 (ループ防止)
 */
export function shouldFixError(source: string, message: string): boolean {
  if (source.startsWith(ERROR_FIX_INJECT_SOURCE)) return false;
  if (source.startsWith("vestigium:")) return true;
  if (source === "discord") {
    if (/rate.?limit|timeout|unavailable|429|50\d|temporarily|ETIMEDOUT|ECONNRESET/i.test(message)) {
      return false;
    }
    return true;
  }
  // 未知 source は安全側に倒して対象外.
  return false;
}

/** Codex に流し込む修正依頼プロンプトを組む. */
export function buildErrorFixPrompt(rec: { source: string; message: string; detail?: Record<string, unknown> }): string {
  const repoHint = rec.source.startsWith("vestigium:")
    ? `対象はサービス "${rec.source.slice("vestigium:".length)}" のリポ。ワークスペース配下から該当リポを特定して作業。`
    : rec.source === "discord"
      ? `対象は Concordia リポ (Discord 連携の失敗)。`
      : `source から対象リポを判断。`;
  const det = rec.detail && Object.keys(rec.detail).length > 0 ? `\ndetail: ${JSON.stringify(rec.detail).slice(0, 500)}` : "";
  return [
    "[error-autofix] 監視で以下のエラーを検知しました。原因を調査して修正してください。",
    `source: ${rec.source}`,
    `message: ${rec.message}`.slice(0, 600) + det,
    repoHint,
    "手順: 該当リポで fix ブランチを切り、修正 → コミット → PR 作成 → CI が green なら squash merge + ブランチ削除 + main 更新まで実施 (Ars 自動マージ規約)。CI red の時は止めて状況を残す。既知の一過性エラーや再現性が無いものは無視してよい。",
  ].join("\n");
}

export interface ErrorFixDispatcherDeps {
  sessions: SessionsRepo;
  /** fixer cwd の既定値 (CONCORDIA_ERROR_AUTOFIX_CWD 未指定時). 通常は config.spawnDefaultCwd. */
  spawnDefaultCwd: string;
}

export interface ErrorFixDispatcherHandle {
  stop: () => void;
  /** テスト用: event を直接食わせる. */
  handle: (ev: ConcordiaEvent) => void;
}

export function startErrorFixDispatcher(deps: ErrorFixDispatcherDeps): ErrorFixDispatcherHandle {
  const enabled = process.env.CONCORDIA_ERROR_AUTOFIX === "1";
  const fixerCwd = process.env.CONCORDIA_ERROR_AUTOFIX_CWD ?? deps.spawnDefaultCwd;

  if (!enabled) {
    log.info("CONCORDIA_ERROR_AUTOFIX != 1; error auto-fix disabled");
    return { stop: () => {}, handle: () => {} };
  }

  const lastSeen = new Map<string, number>();
  const queue: Array<{ source: string; message: string; detail?: Record<string, unknown> }> = [];
  let lastInjectAt = 0;
  let lastSpawnAt = 0;

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** fixer の active codex-cli セッション (repo_path===fixerCwd) を返す. 無ければ null. */
  function findFixer(): SessionRow | null {
    const actives = deps.sessions.listSessions({ status: "active" });
    return actives.find((s) => s.provider === "codex-cli" && s.repo_path === fixerCwd) ?? null;
  }

  function ensureFixer(): SessionRow | null {
    const existing = findFixer();
    if (existing) return existing;
    const now = nowSec();
    if (now - lastSpawnAt < SPAWN_COOLDOWN_SEC) return null;
    lastSpawnAt = now;
    const r = spawnSession({ provider: "codex", mode: "tab", cwd: fixerCwd, title: "[error-fixer]" });
    if (r.ok) log.info(`spawned error-fixer Codex at ${fixerCwd} (pid=${r.pid})`);
    else log.warn(`error-fixer spawn failed: ${r.error}`);
    return null; // 起動直後は未登録. 次の drain で拾う.
  }

  function tryInject(): void {
    if (queue.length === 0) return;
    if (nowSec() - lastInjectAt < MIN_INJECT_INTERVAL_SEC) return;
    const fixer = ensureFixer();
    if (!fixer) return;
    const rec = queue.shift()!;
    eventBus.emit({
      type: "session.inject",
      target_session_id: fixer.id,
      text: buildErrorFixPrompt(rec),
      source: ERROR_FIX_INJECT_SOURCE,
      ts: nowSec(),
    });
    lastInjectAt = nowSec();
    log.info(`injected fix request to fixer ${fixer.id.slice(0, 8)} for ${rec.source}`);
  }

  function handle(ev: ConcordiaEvent): void {
    if (ev.type !== "error.reported") return;
    if (!shouldFixError(ev.source, ev.message)) return;
    const key = `${ev.source}|${ev.message}`;
    const now = nowSec();
    const seen = lastSeen.get(key);
    if (seen !== undefined && now - seen < DEDUPE_SEC) return;
    lastSeen.set(key, now);
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ source: ev.source, message: ev.message, detail: ev.detail });
    tryInject();
  }

  const unsub = eventBus.subscribe(handle);
  // queue 滞留分を定期的に流す (rate-limit / fixer 起動待ちを吸収).
  const supervised = startSupervisedInterval("error-fix-dispatcher", tryInject, {
    intervalMs: 30 * 1000,
    log: { warn: (message) => log.warn(message) },
  });
  log.info(`error auto-fix enabled (fixer cwd=${fixerCwd})`);

  return {
    stop: () => {
      unsub();
      supervised.stop();
    },
    handle,
  };
}
