/**
 * Cc 復帰後の tick が transcript record 宣言を取り込む
 * (spec/feature/escalation-mode.md §1).
 *
 * Cc が止まっている間、 復旧セッションは transcript に `ESCALATION` 宣言を残すだけで進む。
 * 復帰した Cc がそれを読んで同じ内容の escalation_event を作らないと、 「誰がいつ何のために
 * 規律を外したか」 が記録から消える — モードが記録である意味が無くなる。
 *
 * 取り込みは冪等。 tick は同じ transcript を何度も読むので、 同じ session / 同じ開始時刻の
 * event が既にあれば作らない。
 */

import type { EscalationRepo } from "../db/escalation-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import { endEscalation, startEscalation } from "./escalation-mode.js";
import {
  ESCALATION_MARKER,
  extractFrameText,
  parseEscalationTranscriptRecord,
} from "./escalation-transcript-record.js";

/** 走査する transcript の遡り幅。 これより古い宣言は「もう終わった停止」 として拾わない。 */
export const TRANSCRIPT_LOOKBACK_SEC = 24 * 60 * 60;

export interface EscalationIntakeDeps {
  sessions: SessionsRepo;
  escalations: EscalationRepo;
  tasks: TasksRepo;
  transcriptLogs: TranscriptLogsRepo;
}

export interface EscalationIntakeResult {
  started: string[];
  ended: string[];
}

/**
 * transcript の宣言を escalation_event へ取り込む。
 *
 * 復帰直後に走らせる想定で、 開始と解除が両方書かれている transcript では時系列順に
 * 両方を適用する (= 既に解除済みの停止で他セッションを止め直さない)。
 */
export function ingestEscalationTranscriptRecords(
  deps: EscalationIntakeDeps,
  opts: { now?: number; lookbackSec?: number; limit?: number } = {},
): EscalationIntakeResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const sinceTs = now - (opts.lookbackSec ?? TRANSCRIPT_LOOKBACK_SEC);
  const frames = deps.transcriptLogs.listFramesContaining(ESCALATION_MARKER, {
    sinceTs,
    limit: opts.limit ?? 1000,
  });

  const started: string[] = [];
  const ended: string[] = [];

  const parsed = frames.flatMap((frame) => {
    const record = parseEscalationTranscriptRecord(extractFrameText(safeParse(frame.payload)), frame.ts);
    return record ? [{ frame, record }] : [];
  });

  for (const { frame, record } of parsed) {
    if (!deps.sessions.findSession(frame.session_id)) continue;

    if (record.action === "start") {
      // 同じ開始時刻の event が既にあるなら取り込み済み。 API 経由で作られた行も含めて弾く。
      if (deps.escalations.hasEventStartedAt(frame.session_id, record.at)) continue;
      if (deps.escalations.isEscalated(frame.session_id)) continue;
      // 同じ取り込みの中に対になる解除があるなら、 記録だけ作って停止 claim は配らない。
      // 既に終わった停止で他セッションを止めるのを防ぐ (spec/feature/escalation-mode.md §2)。
      const alreadyReleased = parsed.some(
        (other) =>
          other.record.action === "end" &&
          other.frame.session_id === frame.session_id &&
          other.frame.ts >= frame.ts,
      );
      startEscalation(
        deps,
        {
          session_id: frame.session_id,
          actor: "transcript-record",
          reason: record.reason,
          started_at: record.at,
          source: "transcript",
        },
        { deliverStopClaims: !alreadyReleased },
      );
      started.push(frame.session_id);
      continue;
    }

    if (!deps.escalations.isEscalated(frame.session_id)) continue;
    endEscalation(deps, {
      session_id: frame.session_id,
      note: record.note,
      ended_at: record.at,
    });
    ended.push(frame.session_id);
  }

  return { started, ended };
}

function safeParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}
