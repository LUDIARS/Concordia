/**
 * パートタイマーの退勤 (2026-09-01 neco 指示:
 * 「パートタイマーは仕事が終わったら退勤する (セッション終了してターミナルも閉じる)。
 *  これに判断は不要」)。
 *
 * 一次経路はテンプレート側の退勤ステップ (delegation/seed.ts — Lictor sidecar への
 * POST /v1/shutdown で自席を閉じる)。ここはその安全網: 委託 run が終局
 * (completed / failed) を報告したのに子セッションが残っている場合、猶予後に
 * DELETE /v1/sessions/:id (endSessionNow — report 生成 + プロセスツリー kill =
 * ターミナルも閉じる) を人間の確認なしで発行する。
 *
 * 対象は category = "parttimer" の delegation テンプレート由来の run のみ。
 * 子会社所有 delegation 等、テンプレートが引けない call_name は対象外 (安全側)。
 */

import { eventBus, type ConcordiaEvent } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("parttimer-clockout");
const DEFAULT_GRACE_MS = 90_000;

export interface ParttimerClockoutDeps {
  runs: { findRun(id: string): { id: string; call_name: string; child_session_id: string | null } | null };
  /** call_name → 雇用形態カテゴリ。テンプレートが無ければ null。 */
  categoryOf: (callName: string) => string | null;
  sessions: { findSession(id: string): { id: string; status: string } | null };
  /** セッションを終了させる (loopback DELETE /v1/sessions/:id を bootstrap が配線)。 */
  endSession: (sessionId: string) => Promise<void>;
  graceMs?: number;
  subscribe?: (handler: (event: ConcordiaEvent) => void) => () => void;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

export interface ParttimerClockoutHandle {
  stop: () => void;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed"]);

export function startParttimerClockout(deps: ParttimerClockoutDeps): ParttimerClockoutHandle {
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const subscribe = deps.subscribe ?? ((handler) => eventBus.subscribe(handler));
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { clear: () => clearTimeout(t) };
  });
  /** run 1 件につき退勤タイマーは 1 本 (重複 emit / 再入で二重 kill しない)。 */
  const scheduled = new Map<string, { clear: () => void }>();
  let stopped = false;

  const onEvent = (event: ConcordiaEvent): void => {
    if (stopped || event.type !== "delegation.run_changed") return;
    if (!TERMINAL_RUN_STATUSES.has(event.status)) return;
    if (scheduled.has(event.run_id)) return;
    const run = deps.runs.findRun(event.run_id);
    if (!run?.child_session_id) return;
    if (deps.categoryOf(run.call_name) !== "parttimer") return;
    const childSessionId = run.child_session_id;
    if (deps.sessions.findSession(childSessionId)?.status !== "active") return;

    const timer = setTimer(() => {
      scheduled.delete(event.run_id);
      if (stopped) return;
      // 猶予中に自分で退勤 (Lictor shutdown) していれば何もしない。
      if (deps.sessions.findSession(childSessionId)?.status !== "active") return;
      log.info({ run_id: event.run_id, session_id: childSessionId }, "parttimer clock-out: ending lingering session");
      void deps.endSession(childSessionId).catch((error) => {
        log.warn({ run_id: event.run_id, session_id: childSessionId, err: (error as Error).message }, "parttimer clock-out failed");
      });
    }, graceMs);
    scheduled.set(event.run_id, timer);
  };

  const unsubscribe = subscribe(onEvent);
  return {
    stop: () => {
      stopped = true;
      unsubscribe();
      for (const timer of scheduled.values()) timer.clear();
      scheduled.clear();
    },
  };
}
