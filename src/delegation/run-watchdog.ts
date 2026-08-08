/**
 * 委託 run watchdog — 30 分周期で委託先の進捗を機械的に確認する。
 *
 * 「委託して放置」の対策 (2026-08-08 neco 指示)。 LLM は判断に関与しない:
 *   - active な delegation run (launching/spawned/running) を周期走査する。
 *   - 子セッションの transcript_logs の最終 ts を活動時刻とする (last_seen_at は
 *     WS ハートビート = プロセス生存でしかないため使わない — stalled-session-nudge と同方針)。
 *   - idleSec (既定 1800) 以上活動が無く、 ask で人間判断待ちでもなければ、 子へ
 *     「状況を報告せよ」を inject する (= 委託先への確認)。
 *   - 子が死んでいる / 切断している / 確認 maxNudges 回に無応答なら、 親セッションへ
 *     1 回だけエスカレーション通知する。
 *
 * 永続化: 点検・確認・エスカレーションの状態はすべて delegation_runs の watchdog_*
 * 列に持つ (in-memory Map は使わない)。 Cc を再起動しても監視と抑止は外れない。
 *
 * run の status はここでは一切書き換えない (queue.ts:19-22 の「疑わしきは status を
 * 触らない」方針を踏襲。 スロット解放は queue の stale 判定の責務)。
 *
 * spec/tasks/2026-08-08-delegation-run-watchdog.md。
 */

import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";
import { isAwaitingHumanInput, readSessionTranscriptTail, shouldNudge } from "../control/stalled-session-nudge.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";

const log = createChildLogger("delegation-watchdog");

export const DELEGATION_WATCHDOG_SOURCE = "auto:delegation-watchdog";

export interface RunWatchdogRunsRepo {
  listActiveRuns(): DelegationRunRow[];
  recordWatchdogCheck(id: string, nowMs: number): void;
  recordWatchdogNudge(id: string, nowMs: number, lastActivityMs: number): void;
  recordWatchdogEscalation(id: string, nowMs: number): boolean;
}

export interface RunWatchdogSessionsRepo {
  findSession(id: string): SessionRow | null;
  appendEvent(event: { session_id: string; ts: number; kind: string; payload: unknown }): void;
}

export interface DelegationRunWatchdogOptions {
  runs: RunWatchdogRunsRepo;
  sessions: RunWatchdogSessionsRepo;
  /** 子セッションの最終活動時刻 (epoch-秒)。 transcript_logs の MAX(ts)。 null = 計測不能。 */
  lastActivitySec(sessionId: string): number | null;
  /** 有効/無効・閾値は毎 tick live 評価する (WebUI 設定が再起動なしで効く)。 */
  resolveEnabled(): boolean;
  resolveIdleSec(): number;
  resolveMaxNudges(): number;
  /** scan 周期 (ms)。 既定 30 分。 */
  intervalMs?: number;
  now?: () => number;
  /** ask 判定用の transcript 末尾読み (テスト用 seam)。 */
  readTranscriptTail?: (s: SessionRow) => Promise<string | null>;
}

export interface DelegationRunWatchdogHandle {
  stop: () => void;
  /** 1 周分の走査を即実行 (テスト・手動用)。 実施した操作の一覧を返す。 */
  runOnce: () => Promise<Array<{ runId: string; action: "nudged" | "escalated" }>>;
}

/** 子への確認 inject の本文。 委託先はこの run の子セッション (AI)。 */
export function buildChildNudgeText(run: DelegationRunRow, idleMinutes: number): string {
  return [
    `[delegation:${run.id}] [自動確認] 委託元へ状況報告が ${idleMinutes} 分以上届いていません。`,
    "",
    "- 現在の進捗と残作業を 1〜3 行で整理してください。",
    `- 作業が続くなら継続し、完了/失敗なら POST /v1/delegation/runs/${run.id}/status で報告してください。`,
    "- 詰まっている場合は原因を 1 行で報告し、人間の判断が必要なら ask マーカーで質問してください。",
  ].join("\n");
}

/** 親へのエスカレーション本文。 理由は機械判定の事実だけを書く。 */
export function buildEscalationText(
  run: DelegationRunRow,
  reason: "child_missing" | "child_not_active" | "child_disconnected" | "unresponsive",
  nudgeCount: number,
): string {
  const reasonText = {
    child_missing: "子セッションが見つかりません",
    child_not_active: "子セッションが終了しています (status 報告なし)",
    child_disconnected: "子セッションの接続が切れており、確認を届けられません",
    unresponsive: `${nudgeCount} 回の自動確認に応答がありません`,
  }[reason];
  return [
    `[delegation:${run.id}] [watchdog] 委託先が停滞しています: ${reasonText}。`,
    `child: ${run.child_session_id ?? "(未紐付け)"} / call: ${run.call_name}`,
    "run の状況を確認し、再委託・失敗処理・引き取りのいずれかを判断してください。",
  ].join("\n");
}

export function startDelegationRunWatchdog(
  opts: DelegationRunWatchdogOptions,
): DelegationRunWatchdogHandle {
  const intervalMs = opts.intervalMs ?? 30 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const readTail = opts.readTranscriptTail ?? readSessionTranscriptTail;
  let supervised: SupervisedIntervalHandle | null = null;

  function escalate(
    run: DelegationRunRow,
    reason: Parameters<typeof buildEscalationText>[1],
    nowMs: number,
  ): boolean {
    // DB 側の条件付き UPDATE が 1 回きりを保証する (再起動をまたいでも二重通知しない)。
    if (!opts.runs.recordWatchdogEscalation(run.id, nowMs)) return false;
    const nowSec = Math.floor(nowMs / 1000);
    const text = buildEscalationText(run, reason, run.watchdog_nudge_count ?? 0);
    if (run.parent_session_id) {
      // 親が生きていれば status 通知 (api/delegation.ts) と同じ 3 点セットで届ける。
      opts.sessions.appendEvent({
        session_id: run.parent_session_id,
        ts: nowSec,
        kind: "inject",
        payload: { text, source: `delegation:${run.id}:watchdog` },
      });
      eventBus.emit({
        type: "session.inject",
        target_session_id: run.parent_session_id,
        text,
        source: `delegation:${run.id}:watchdog`,
        ts: nowSec,
      });
      eventBus.emit({
        type: "delegation.mirror",
        target_session_id: run.parent_session_id,
        run_id: run.id,
        child_session_id: run.child_session_id,
        text,
        ts: nowSec,
      });
    }
    log.warn(
      { run_id: run.id, child_session_id: run.child_session_id, reason, parent_session_id: run.parent_session_id },
      "delegation run escalated to parent",
    );
    return true;
  }

  async function runOnce(): Promise<Array<{ runId: string; action: "nudged" | "escalated" }>> {
    if (!opts.resolveEnabled()) return [];
    const nowMs = now();
    const idleThresholdMs = Math.max(1, opts.resolveIdleSec()) * 1000;
    const maxNudges = Math.max(1, opts.resolveMaxNudges());
    const actions: Array<{ runId: string; action: "nudged" | "escalated" }> = [];

    for (const run of opts.runs.listActiveRuns()) {
      // 子が未紐付けの run は spawn 待ちか spawn 失敗。 6h の stale 判定は queue の責務。
      if (!run.child_session_id) continue;
      opts.runs.recordWatchdogCheck(run.id, nowMs);

      const child = opts.sessions.findSession(run.child_session_id);
      if (!child) {
        if (escalate(run, "child_missing", nowMs)) actions.push({ runId: run.id, action: "escalated" });
        continue;
      }
      if (child.status !== "active") {
        // completed/failed の status 報告なしに子だけが終了した = 放置された委託。
        if (escalate(run, "child_not_active", nowMs)) actions.push({ runId: run.id, action: "escalated" });
        continue;
      }

      const lastSec = opts.lastActivitySec(run.child_session_id);
      if (lastSec == null) continue; // 計測不能は触らない (誤 nudge より安全側)。
      const lastActivityMs = lastSec * 1000;
      const idleMs = nowMs - lastActivityMs;
      if (
        !shouldNudge({
          idleMs,
          idleThresholdMs,
          awaiting: false,
          lastNudgeMs: run.watchdog_last_nudge_at ?? null,
          cooldownMs: idleThresholdMs,
          nowMs,
        })
      ) {
        continue;
      }

      const unansweredNudges = run.watchdog_last_nudge_at != null && lastActivityMs > run.watchdog_last_nudge_at
        ? 0
        : (run.watchdog_nudge_count ?? 0);
      if (unansweredNudges >= maxNudges) {
        if (escalate(run, "unresponsive", nowMs)) actions.push({ runId: run.id, action: "escalated" });
        continue;
      }
      if (child.ws_clients <= 0) {
        // 接続が無いと inject は届かない (silent drop)。 確認できない事実を親へ上げる。
        if (escalate(run, "child_disconnected", nowMs)) actions.push({ runId: run.id, action: "escalated" });
        continue;
      }
      if (isAwaitingHumanInput(await readTail(child))) {
        log.debug({ run_id: run.id }, "skip nudge: child is awaiting human input (ask)");
        continue;
      }

      opts.runs.recordWatchdogNudge(run.id, nowMs, lastActivityMs);
      const nowSec = Math.floor(nowMs / 1000);
      const text = buildChildNudgeText(run, Math.round(idleMs / 60_000));
      opts.sessions.appendEvent({
        session_id: run.child_session_id,
        ts: nowSec,
        kind: "inject",
        payload: { text, source: DELEGATION_WATCHDOG_SOURCE },
      });
      eventBus.emit({
        type: "session.inject",
        target_session_id: run.child_session_id,
        text,
        source: DELEGATION_WATCHDOG_SOURCE,
        ts: nowSec,
      });
      actions.push({ runId: run.id, action: "nudged" });
      log.info(
        { run_id: run.id, child_session_id: run.child_session_id, idle_sec: Math.round(idleMs / 1000) },
        "delegation child nudged for a status report",
      );
    }
    return actions;
  }

  supervised = startSupervisedInterval("delegation-run-watchdog", runOnce, {
    intervalMs,
    log: { warn: (message) => log.warn(message) },
  });
  log.info({ intervalMs }, "delegation run watchdog started");

  return {
    stop: () => {
      supervised?.stop();
      supervised = null;
    },
    runOnce,
  };
}
