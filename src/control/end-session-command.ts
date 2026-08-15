/**
 * `/end-session` (= `DELETE /v1/sessions/:id`) の実体。
 *
 * HTTP ルートと、 発話由来の終了要求ウォッチャ (end-session-request.ts) の両方が
 * **同じ関数** を呼ぶ。 終了の副作用 (session-end inject → pending 印 → ended →
 * report/独白) は 1 箇所にしか無い、 という状態を保つための境界。
 *
 * @implements spec/feature/session-end-request.md
 */

import type { ChatRepo } from "../db/chat-repo.js";
import type { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import type { SessionReportRow, SessionRow } from "../shared/types.js";
import type { SummaryQuestionStateReader } from "../report/summary-event-excerpt.js";
import {
  AUTO_SESSION_END_INJECT_SOURCE,
  emitAutoSessionEndInject,
  pickSessionEndInjectText,
} from "./auto-session-end-inject.js";
import { runSessionEndFlow } from "./end-session-flow.js";
import { isSessionEndPending, SESSION_END_PENDING_AT_KEY } from "./session-end-process.js";

export interface EndSessionCommandDeps {
  repo: SessionsRepo;
  chat: ChatRepo;
  config: ConcordiaConfig;
  harnessAudit?: HarnessAuditRepo;
  transcriptLogs: TranscriptLogsRepo;
  questionState: SummaryQuestionStateReader;
  /** spawn で紐付いた Memoria タスクの完了口 (正常終了時のみ)。 */
  memoria?: { completeTask?(id: number): Promise<void> };
}

export interface EndSessionCommandResult {
  session: SessionRow;
  report: SessionReportRow | null;
}

/**
 * セッションを終了させる。 呼び出し側は session の存在確認だけ済ませておく。
 *
 * @param reason 終了契機 (inject event の記録に載せる)。 監査でどの経路から
 *               終了したかを追えるようにするためのラベル。
 */
export async function endSessionNow(
  deps: EndSessionCommandDeps,
  requestedSession: SessionRow,
  reason: string,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<EndSessionCommandResult> {
  // watcher と HTTP DELETE が同じ session を同時に拾っても、先に ended 化した側だけが
  // inject / end event / report を実行する。DB 操作までは await が無いため、この再取得で
  // 同一 Node プロセス内の呼び出しを直列化できる。
  const session = deps.repo.findSession(requestedSession.id);
  if (!session) throw new Error(`session not found while ending: ${requestedSession.id}`);
  if (session.status === "ended") {
    return { session, report: deps.repo.findReport(session.id) };
  }
  const now = nowSec();
  // fire-and-forget: Lictor WS が無い / failure でも report 生成は続行
  try {
    const injected = emitAutoSessionEndInject(session);
    if (injected) {
      deps.repo.appendEvent({
        session_id: session.id,
        ts: now,
        kind: "inject",
        payload: {
          text: pickSessionEndInjectText(session.provider),
          source: AUTO_SESSION_END_INJECT_SOURCE,
          reason,
        },
      });
    }
  } catch { /* swallow — best effort */ }
  const alreadyPending = isSessionEndPending(session.metadata);
  if (session.status === "active" && !alreadyPending) {
    deps.repo.mergeMetadata(session.id, { [SESSION_END_PENDING_AT_KEY]: now });
  }
  deps.repo.setStatus(session.id, "ended", now, now);
  deps.repo.appendEvent({
    session_id: session.id,
    ts: now,
    kind: "end",
    payload: { duration_sec: now - session.started_at },
  });
  const ended = deps.repo.findSession(session.id)!;
  const { report } = await runSessionEndFlow(
    {
      repo: deps.repo,
      chat: deps.chat,
      config: deps.config,
      harnessAudit: deps.harnessAudit,
      // codex-sdk の usage は transcript frame にしか無い。 こちらが通常の
      // 終了経路なので、 admin stop と同じく frame ソースを渡す。
      usageFrames: deps.transcriptLogs,
      questionState: deps.questionState,
      memoria: deps.memoria,
    },
    ended,
  );
  return { session: ended, report };
}
