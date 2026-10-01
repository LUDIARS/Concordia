/**
 * 英語に流れたセッションへ「日本語で」と inject する (spec/feature/session-language-guard.md)。
 *
 * 背景: Opus が途中から英語だけで話し続けることがある (2026-10-01 neco)。多くは最終回答の前の
 * 途中発言から英語になり、そのまま続く。途中発言を見て補正を入れれば、最終回答は日本語で受け取れる。
 *
 * - assistant の発言 (transcript.frame の text) を見て、英語なら 1 回だけ補正を inject する。
 * - 補正後は、日本語の発言が出るか人間の発言が届くまで再送しない (CC-LANG-INV-02)。
 *   英語のまま無視され続けても、補正が連続して積み上がらない。
 * - 未回答の質問があるセッションには送らない (他の自動 inject と同じ門番)。
 * - 再放流された古い frame (transcript-replay) には反応しない。
 *
 * @implements SPEC-LANG-GUARD
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { judgeLanguageDrift, isJapaneseProse } from "./language-drift.js";
import { allowAutoInject, type PendingQuestionProbe } from "./pending-question-blocker.js";
import { parseRequesterSource } from "./requester.js";

export const LANGUAGE_GUARD_SOURCE = "auto:language-guard";
/** 同じセッションへ補正を入れる最短間隔 (秒)。日英が交互に出ても補正を連打しない。 */
export const LANGUAGE_GUARD_COOLDOWN_SEC = 120;
/** これより古い frame は再放流とみなして見ない (秒)。 */
export const LANGUAGE_GUARD_STALE_FRAME_SEC = 300;

export const LANGUAGE_GUARD_TEXT = [
  "[言語補正] 直前の発言が英語になっています。",
  "このセッションの応答は日本語で書いてください (コード・コマンド・固有名詞・引用はそのままで構いません)。",
  "作業の途中なら、そのまま日本語で続けてください。最終報告まで英語で書き終えていた場合は、その要点を日本語で言い直してください。",
].join("\n");

interface SessionLanguageState {
  /** 補正を入れて、まだ日本語に戻ったのを見ていない。 */
  corrected: boolean;
  lastInjectedAt: number | null;
}

export interface LanguageGuardDeps {
  isEnabled(): boolean;
  isActiveSession(sessionId: string): boolean;
  hasPendingQuestion?: PendingQuestionProbe;
  inject(sessionId: string, text: string, at: number): void;
  now(): number;
  log?: { info: (message: string) => void };
}

export interface LanguageGuard {
  /** assistant の発言を 1 つ見る。 frameTs は frame の時刻 (秒)。 */
  onAssistantText(sessionId: string, text: string, frameTs: number): void;
  /** 人間の発言が届いた (新しい指示なので補正の機会を戻す)。 */
  onHumanInject(sessionId: string): void;
  forget(sessionId: string): void;
}

export function createLanguageGuard(deps: LanguageGuardDeps): LanguageGuard {
  const states = new Map<string, SessionLanguageState>();
  const stateOf = (sessionId: string): SessionLanguageState => {
    let state = states.get(sessionId);
    if (!state) {
      state = { corrected: false, lastInjectedAt: null };
      states.set(sessionId, state);
    }
    return state;
  };

  return {
    onAssistantText(sessionId, text, frameTs) {
      if (!deps.isEnabled()) return;
      const now = deps.now();
      if (now - frameTs > LANGUAGE_GUARD_STALE_FRAME_SEC) return;
      const state = stateOf(sessionId);
      if (!judgeLanguageDrift(text).english) {
        if (state.corrected && isJapaneseProse(text)) state.corrected = false;
        return;
      }
      if (state.corrected) return;
      if (state.lastInjectedAt !== null && now - state.lastInjectedAt < LANGUAGE_GUARD_COOLDOWN_SEC) return;
      if (!deps.isActiveSession(sessionId)) return;
      if (!allowAutoInject({ probe: deps.hasPendingQuestion, sessionId, source: LANGUAGE_GUARD_SOURCE, log: deps.log })) return;
      deps.inject(sessionId, LANGUAGE_GUARD_TEXT, now);
      state.corrected = true;
      state.lastInjectedAt = now;
      deps.log?.info(`language guard injected session=${sessionId}`);
    },
    onHumanInject(sessionId) {
      const state = states.get(sessionId);
      if (state) state.corrected = false;
    },
    forget(sessionId) {
      states.delete(sessionId);
    },
  };
}

/**
 * transcript.frame から assistant の本文を取り出す (それ以外は null)。
 * @implements SPEC-LANG-GUARD
 */
export function assistantTextOf(ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>): string | null {
  if (ev.kind !== "text") return null;
  const payload = ev.payload as { role?: unknown; text?: unknown } | null | undefined;
  return payload?.role === "assistant" && typeof payload.text === "string" && payload.text ? payload.text : null;
}

export interface StartLanguageGuardOptions {
  repo: Pick<SessionsRepo, "findSession" | "appendEvent">;
  isEnabled(): boolean;
  hasPendingQuestion?: PendingQuestionProbe;
  now?: () => number;
  log?: { info: (message: string) => void };
}

/**
 * イベントバスに補正を配線する (frame を見て補正、人間の inject で再武装、終了で状態を捨てる)。
 * @implements SPEC-LANG-GUARD
 */
export function startLanguageGuard(opts: StartLanguageGuardOptions): { stop(): void } {
  const guard = createLanguageGuard({
    isEnabled: opts.isEnabled,
    isActiveSession: (sessionId) => opts.repo.findSession(sessionId)?.status === "active",
    hasPendingQuestion: opts.hasPendingQuestion,
    now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
    log: opts.log,
    inject: (sessionId, text, at) => {
      opts.repo.appendEvent({ session_id: sessionId, ts: at, kind: "inject", payload: { text, source: LANGUAGE_GUARD_SOURCE } });
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source: LANGUAGE_GUARD_SOURCE, ts: at });
    },
  });
  const unsubscribe = eventBus.subscribe((ev) => {
    if (ev.type === "transcript.frame") {
      const text = assistantTextOf(ev);
      if (text) guard.onAssistantText(ev.target_session_id, text, ev.ts);
      return;
    }
    if (ev.type === "session.inject") {
      if (parseRequesterSource(ev.source)) guard.onHumanInject(ev.target_session_id);
      return;
    }
    if (ev.type === "session.ended" || ev.type === "session.lost") guard.forget(ev.session_id);
  });
  opts.log?.info("language guard started");
  return { stop: unsubscribe };
}
