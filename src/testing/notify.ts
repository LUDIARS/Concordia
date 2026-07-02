/**
 * テスト交通整備の inject 通知。 sessions API の relictor inject と同じ経路
 * (session_events 記録 + eventBus "session.inject") でセッションへ文面を届ける。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";

export const TESTING_INJECT_SOURCE = "testing-traffic";

export function injectTestingNotice(repo: SessionsRepo, sessionId: string, text: string): void {
  const ts = Math.floor(Date.now() / 1000);
  try {
    repo.appendEvent({ session_id: sessionId, ts, kind: "inject", payload: { text, source: TESTING_INJECT_SOURCE } });
  } catch {
    /* 監査記録は best-effort (通知本体は eventBus 側) */
  }
  eventBus.emit({
    type: "session.inject",
    target_session_id: sessionId,
    text,
    source: TESTING_INJECT_SOURCE,
    ts,
  });
}
