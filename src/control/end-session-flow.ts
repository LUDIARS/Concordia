/**
 * Session end フロー共通化.
 *
 * `DELETE /v1/sessions/:id` と `POST /v1/admin/stop-session/:id` の両方が
 * セッション終了時に以下を実行する:
 *   1. aggregateBullets (+ dispatcher.onSessionEnd は現在 no-op、 独白は report 経路が担う)
 *   2. generateReport → upsertReport  (per-session レポート、 claude CLI で narrative)
 *   3. report 冒頭の独白を #報告 channel に投稿 + chat-reply task ばらまき
 *   4. eventBus.emit session.ended + report.generated
 *   5. persona feedback + release
 *
 * 呼び出し側は事前に「ステータスを ended にする」「end event を append する」
 * のは自分でやる (停止契機の payload が異なる ため). この helper は
 * **既に status=ended になっている session** を受け取って後段だけ流す.
 *
 * 失敗ポリシー: report 生成は claude CLI 呼び出しを含むので落ちうる. ここで
 * throw すると呼び出し元の HTTP ハンドラが 500 を返す & kill 結果が返らない
 * 問題があるため、 個々のステップは try/catch で吸収し warn ログだけ残す.
 * 「セッション終了は確定したが レポートは作れなかった」 という half-success を
 * 呼び出し元に返せるよう {@link SessionEndFlowResult} を返す.
 */

import type { ChatRepo } from "../db/chat-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { Dispatcher } from "../dispatcher.js";
import { eventBus } from "../events.js";
import { applySessionEndFeedback } from "../personas/feedback.js";
import { aggregateBullets, generateReport } from "../report/generator.js";
import { lastHumanRequester } from "./requester.js";
import type { SummaryFlags } from "../report/summary-flags.js";
import type { ConcordiaConfig } from "../shared/config.js";
import { createChildLogger } from "../shared/logger.js";
import type { SessionEventRow, SessionReportRow, SessionRow } from "../shared/types.js";

const log = createChildLogger("end-session-flow");

/**
 * needsHuman (人間確認事項) があれば、 独白の冒頭に起因者メンション + 箇条書き通知を被せる。
 * report.metadata.summary_flags は ④ generator が入れる。 無ければ独白そのまま。
 */
export function withNeedsHumanNotice(
  monologue: string,
  report: SessionReportRow,
  recentEvents: SessionEventRow[],
): string {
  let flags: SummaryFlags | null = null;
  if (report.metadata) {
    try {
      flags = (JSON.parse(report.metadata) as { summary_flags?: SummaryFlags }).summary_flags ?? null;
    } catch {
      flags = null;
    }
  }
  if (!flags || flags.needsHuman.length === 0) return monologue;
  const req = lastHumanRequester(recentEvents);
  const mention = req?.platform === "discord" && req.userId ? `<@${req.userId}> ` : "";
  const list = flags.needsHuman.map((n) => `- ${n}`).join("\n");
  return `${mention}⚠️ 人間の確認が必要な事項があります:\n${list}\n\n${monologue}`;
}

export interface EndSessionFlowDeps {
  repo: SessionsRepo;
  chat: ChatRepo;
  dispatcher: Dispatcher;
  personas: PersonasRepo;
  config: ConcordiaConfig;
}

export interface SessionEndFlowResult {
  /** 生成済 report 行. 生成に失敗した場合は null. */
  report: SessionReportRow | null;
  /** #報告 channel に投稿した chat_message_id. 投稿しなかった場合は null. */
  postedMessageId: number | null;
}

/**
 * 終了済 (status=ended) session に対して reporting + persona release を実行する.
 * 呼び出し前提:
 *   - `deps.repo.findSession(id)` が ended 済 row を返すこと
 *   - 呼び出し側で end event を append 済 (deps.repo.allEvents が拾える)
 */
export async function runSessionEndFlow(
  deps: EndSessionFlowDeps,
  endedSession: SessionRow,
): Promise<SessionEndFlowResult> {
  const id = endedSession.id;
  const now = endedSession.ended_at ?? Math.floor(Date.now() / 1000);

  // 1. aggregateBullets (+ dispatcher.onSessionEnd は no-op: 独白は report 経路)
  let bullets: object = {};
  try {
    const events = deps.repo.allEvents(id);
    bullets = aggregateBullets(endedSession, events);
    deps.dispatcher.onSessionEnd(endedSession, bullets);
  } catch (err) {
    log.warn({ session_id: id, err: (err as Error).message }, "aggregateBullets/onSessionEnd failed");
  }

  // 2. generateReport — claude CLI を叩くので落ちうる. 失敗時は report=null で続行.
  let report: SessionReportRow | null = null;
  try {
    const events = deps.repo.allEvents(id);
    report = await generateReport(endedSession, events);
    deps.repo.upsertReport(report);
  } catch (err) {
    log.warn(
      { session_id: id, err: (err as Error).message },
      "generateReport failed; session end completes without per-session report",
    );
  }

  // 3. 独白を #報告 channel に投稿 (report が生成できた時だけ)
  let postedMessageId: number | null = null;
  if (report) {
    const monologue = extractMonologue(report.summary_md);
    if (monologue) {
      try {
        const role = parseSessionRole(endedSession);
        // ④ 人間確認事項 (needsHuman) があれば、 起因者 (直近で指示した人間) を @メンションして
        // 独白の冒頭に通知を被せる (Discord)。 report.metadata に summary_flags が入る。
        const text = withNeedsHumanNotice(monologue, report, deps.repo.recentEvents(id, 50));
        const msg = deps.chat.insert({
          channel: "報告",
          session_id: id,
          author_label: role,
          text,
          in_reply_to: null,
          is_actionable: false,
          metadata: JSON.stringify({ from_report: true, session_id: id }),
        });
        postedMessageId = msg.id;
        deps.dispatcher.onChatPosted({
          id: msg.id,
          channel: msg.channel,
          session_id: msg.session_id,
          text: msg.text,
          author_label: msg.author_label,
          is_actionable: false,
        });
        eventBus.emit({
          type: "chat.posted",
          message_id: msg.id,
          channel: msg.channel,
          author_label: msg.author_label,
          ts: msg.ts,
          is_actionable: false,
        });
      } catch (err) {
        log.warn({ session_id: id, err: (err as Error).message }, "monologue post failed");
      }
    }
  }

  // 4. session.ended + report.generated events
  eventBus.emit({ type: "session.ended", session_id: id, ts: now });
  if (report) {
    eventBus.emit({ type: "report.generated", session_id: id, ts: now });
  }

  // 5. persona feedback + release
  try {
    const assignment = deps.personas.findActiveBySession(id);
    if (assignment) {
      const persona = deps.personas.find(assignment.persona_id);
      if (persona) {
        await applySessionEndFeedback(
          { personas: deps.personas, chat: deps.chat },
          endedSession,
          persona,
        );
      }
      deps.personas.release(id);
      eventBus.emit({
        type: "persona.released",
        session_id: id,
        persona_id: assignment.persona_id,
        ts: now,
      });
    }
  } catch (err) {
    log.warn({ session_id: id, err: (err as Error).message }, "persona feedback/release failed");
  }

  return { report, postedMessageId };
}

/**
 * report の summary_md から「独白」 (冒頭の poem 部分) を抽出.
 * 3 セクション構造 (poem / "---" / 業務報告 / "---" / サマリ) を前提に、
 * 最初の "---" より前を返す. 失敗したら null.
 *
 * NOTE: sessions.ts 内の同名 helper と同実装. ここで再定義しているのは循環
 * import を避けるため. 仕様が変わったら両方更新する.
 */
function extractMonologue(summaryMd: string): string | null {
  const sep = summaryMd.indexOf("\n---");
  if (sep <= 0) return null;
  const head = summaryMd.slice(0, sep).trim();
  if (head.length < 10 || head.length > 1500) return null;
  return head;
}

function parseSessionRole(s: SessionRow): string {
  if (!s.metadata) return "雑用係";
  try {
    const m = JSON.parse(s.metadata) as { role_label?: string };
    return m.role_label ?? "雑用係";
  } catch {
    return "雑用係";
  }
}
