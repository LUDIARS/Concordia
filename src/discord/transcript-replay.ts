/**
 * session channel 作成前に届いた transcript frame の再放流 (replay)。
 *
 * transcript-frame POST は「session が active かつ Discord channel 行が active」
 * のときだけ eventBus へ broadcast され、 それ以外は永続化のみで捨てられる
 * (api/sessions/relay.ts の gate)。 channel 作成は Discord bot が session.started
 * を処理して初めて行われるため、 spawn 直後〜channel 作成完了までの frame は
 * これまで Discord/Slack に一切届かなかった (2026-07-12: bot のイベント処理遅延で
 * この窓が約 10 分に伸び、 リレーが「詰まって見える」実障害)。
 *
 * ここでは channel 作成直後に、 永続化済み frame のうち id <= upToId のものを
 * eventBus へ流し直して取りこぼしを埋める。
 */

import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import type { TranscriptLogEntry } from "../db/transcript-logs-repo.js";

/**
 * egress が実際に Discord へ投稿する kind のみ再放流する (text / summary。
 * tool-use / thinking / raw 等は egress 側で skip されるだけなので流さない —
 * バックログ由来のイベント洪水と skip ログ空撃ちを避ける)。
 */
const REPLAY_KINDS = new Set(["text", "summary"]);

/** 再放流の上限。 長時間詰まったセッションでも直近分だけ埋める (Discord 洪水防止)。 */
const REPLAY_MAX_FRAMES = 200;

export interface TranscriptReplaySource {
  listBySession(
    session_id: string,
    opts?: { limit?: number; tail?: boolean },
  ): TranscriptLogEntry[];
}

export interface TranscriptReplayDeps {
  transcriptLogs: TranscriptReplaySource;
  log: { info: (m: string) => void };
  /** テスト差し替え用。 既定は eventBus.emit。 */
  emit?: (ev: ConcordiaEvent) => void;
}

/**
 * 永続化済み transcript frame を eventBus へ再放流する。
 *
 * @param upToId channel 行作成直後に取った transcript_logs.maxId。 それ以降
 *   (id > upToId) の frame は relay gate を通ってライブ配信されるため、 replay は
 *   id <= upToId に限定して二重配信を防ぐ。 (channel 行の upsert から upToId 取得
 *   までの短い窓でライブ配信済み frame が混ざり得るが、 損失より重複を許容する。)
 * @returns 再放流した frame 数。
 */
export function replayPersistedTranscript(
  deps: TranscriptReplayDeps,
  sessionId: string,
  upToId: number,
): number {
  if (upToId <= 0) return 0;
  const emit = deps.emit ?? ((ev: ConcordiaEvent) => eventBus.emit(ev));
  const entries = deps.transcriptLogs.listBySession(sessionId, {
    limit: REPLAY_MAX_FRAMES,
    tail: true,
  });
  let replayed = 0;
  for (const entry of entries) {
    if (entry.id > upToId) continue;
    if (!REPLAY_KINDS.has(entry.kind)) continue;
    emit({
      type: "transcript.frame",
      target_session_id: sessionId,
      seq: entry.seq,
      kind: entry.kind,
      payload: entry.payload,
      ts: entry.ts,
    });
    replayed += 1;
  }
  if (replayed > 0) {
    deps.log.info(
      `transcript-replay: session=${sessionId} replayed=${replayed} up_to_id=${upToId}`,
    );
  }
  return replayed;
}
