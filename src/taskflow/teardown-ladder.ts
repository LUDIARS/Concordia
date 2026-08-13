import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { AUTO_SESSION_END_INJECT_SOURCE, pickSessionEndInjectText } from "../control/auto-session-end-inject.js";
import type { SessionRow } from "../shared/types.js";
import { createChildLogger } from "../shared/logger.js";

export const TEARDOWN_LADDER_META_KEY = "teardown_ladder";
const DEFAULT_RETRY_SEC = 300;
const DEFAULT_FORCE_SEC = 900;
const log = createChildLogger("teardown-ladder");

export interface TeardownLadderState {
  run_key: string;
  started_at: number;
  retries_sent: number;
}

function metadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

export function readTeardownLadder(raw: string | null): TeardownLadderState | null {
  const value = metadata(raw)[TEARDOWN_LADDER_META_KEY];
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<TeardownLadderState>;
  return typeof state.run_key === "string" && typeof state.started_at === "number" && typeof state.retries_sent === "number"
    ? state as TeardownLadderState
    : null;
}

function injectSessionEnd(sessions: SessionsRepo, session: SessionRow, runKey: string, attempt: number, now: number): void {
  const text = pickSessionEndInjectText(session.provider);
  sessions.appendEvent({
    session_id: session.id,
    ts: now,
    kind: "inject",
    payload: { text, source: AUTO_SESSION_END_INJECT_SOURCE, run_key: runKey, attempt },
  });
  eventBus.emit({ type: "session.inject", target_session_id: session.id, text, source: AUTO_SESSION_END_INJECT_SOURCE, ts: now });
}

/** run 単位 exactly-once で t0 inject と永続 schedule を作る。 */
export function scheduleTeardownLadder(sessions: SessionsRepo, session: SessionRow, runKey: string, now: number): boolean {
  const current = readTeardownLadder(session.metadata);
  if (current?.run_key === runKey) return false;
  injectSessionEnd(sessions, session, runKey, 0, now);
  sessions.mergeMetadata(session.id, {
    [TEARDOWN_LADDER_META_KEY]: { run_key: runKey, started_at: now, retries_sent: 0 },
  });
  return true;
}

export interface TeardownLadderWatchDeps {
  sessions: SessionsRepo;
  endSession: (session: SessionRow, reason: string) => Promise<unknown>;
  retrySec?: number;
  forceSec?: number;
  intervalMs?: number;
  nowSec?: () => number;
}

export function startTeardownLadderWatch(deps: TeardownLadderWatchDeps): { stop(): void } {
  const retrySec = deps.retrySec ?? Number(process.env.CONCORDIA_TEARDOWN_RETRY_SEC ?? DEFAULT_RETRY_SEC);
  const forceSec = deps.forceSec ?? Number(process.env.CONCORDIA_TEARDOWN_FORCE_SEC ?? DEFAULT_FORCE_SEC);
  if (!Number.isFinite(retrySec) || retrySec <= 0 || !Number.isFinite(forceSec) || forceSec < retrySec * 2) {
    throw new Error("invalid teardown ladder timing configuration");
  }
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const inFlight = new Set<string>();
  const tick = async (): Promise<void> => {
    const now = nowSec();
    for (const session of deps.sessions.listSessions({ status: "active" })) {
      const state = readTeardownLadder(session.metadata);
      if (!state || inFlight.has(session.id)) continue;
      const elapsed = now - state.started_at;
      if (elapsed >= forceSec) {
        inFlight.add(session.id);
        try {
          deps.sessions.appendEvent({ session_id: session.id, ts: now, kind: "teardown_forced", payload: { run_key: state.run_key, elapsed_sec: elapsed } });
          await deps.endSession(session, "teardown ladder forced");
        } finally {
          inFlight.delete(session.id);
        }
        continue;
      }
      const dueRetries = Math.min(2, Math.floor(elapsed / retrySec));
      if (dueRetries <= state.retries_sent) continue;
      injectSessionEnd(deps.sessions, session, state.run_key, dueRetries, now);
      deps.sessions.mergeMetadata(session.id, {
        [TEARDOWN_LADDER_META_KEY]: { ...state, retries_sent: dueRetries },
      });
    }
  };
  const timer = setInterval(() => {
    void tick().catch((error) => log.warn({ error }, "teardown ladder tick failed"));
  }, deps.intervalMs ?? 30_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
