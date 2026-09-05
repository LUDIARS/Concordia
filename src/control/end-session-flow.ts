/**
 * Session end フロー共通化.
 *
 * `DELETE /v1/sessions/:id` と `POST /v1/admin/stop-session/:id` の両方が
 * セッション終了時に以下を実行する:
 *   1. spawn で紐付いた Memoria タスクを完了
 *   2. eventBus.emit session.ended
 *   3. generateReport → upsertReport  (per-session レポート、 claude CLI で narrative)
 *   4. report 冒頭の独白を #報告 channel に投稿
 *   5. eventBus.emit report.generated
 *
 * このうち 3〜5 は **リクエストパスから外して** 非同期で走る
 * (下記「リクエストパスと report 生成の分離」)。
 *
 * 呼び出し側は事前に「ステータスを ended にする」「end event を append する」
 * のは自分でやる (停止契機の payload が異なる ため). この helper は
 * **既に status=ended になっている session** を受け取って後段だけ流す.
 *
 * ## リクエストパスと report 生成の分離
 *
 * 3 (generateReport) は `claude -p` を **2 回直列で** 起動する
 * (narrative=haiku / summary flags=sonnet)。子プロセス自体は非同期だが、完了を待つ間は
 * HTTP 応答が十数秒保留されるため、report は終了応答から切り離す。
 *
 * そこで **終了確定 (1・2) と report 生成 (3〜5) を分ける**:
 *   - {@link runSessionEndFlow}      … LLM を呼ばない。 呼び出し元が await する。
 *   - {@link scheduleSessionReport}  … report + 独白投稿。 fire-and-forget.
 *
 * report は元々「失敗したら null で続行」 する best-effort な副産物なので、
 * 呼び出し元が結果を待つ必然性が無い (実際 DELETE 以外の呼び出し元は report を
 * 捨てている).
 *
 * 失敗ポリシー: report 生成は claude CLI 呼び出しを含むので落ちうる. ここで
 * throw すると呼び出し元の HTTP ハンドラが 500 を返す & kill 結果が返らない
 * 問題があるため、 個々のステップは try/catch で吸収し warn ログだけ残す.
 * 「セッション終了は確定したが レポートは作れなかった」 という half-success を
 * 呼び出し元に返せるよう {@link SessionEndFlowResult} を返す.
 */

import type { ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { aggregateBullets, generateReport } from "../report/generator.js";
import { lastHumanRequester } from "./requester.js";
import type { SummaryFlags } from "../report/summary-flags.js";
import type { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import type { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
import type { ConcordiaConfig } from "../shared/config.js";
import { createChildLogger } from "../shared/logger.js";
import type { SessionEventRow, SessionReportRow, SessionRow } from "../shared/types.js";
import type { SummaryQuestionStateReader } from "../report/summary-event-excerpt.js";

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
  config: ConcordiaConfig;
  /** あればブロック検出に決定論ソース (harness 監査 deny 行) を併用。 */
  harnessAudit?: HarnessAuditRepo;
  /**
   * codex-sdk セッションの usage は transcript frame にしか無い。
   *
   * 型を cost 層 (`UsageFrameSource`) から取らないのは、control → cost の
   * import を `core-no-cost-write` が禁じているため。frame を持つのは
   * transcript repo なので、必要なメソッドだけを repo 側の型から借りる。
   */
  usageFrames?: Pick<TranscriptLogsRepo, "listUsagePayloads">;
  /** 回答 event 欠落時も質問の durable state を report へ反映する。 */
  questionState?: SummaryQuestionStateReader;
  /**
   * spawn 時に選ばれた Memoria タスクを完了にする口 (spec/feature/teams.md §2)。
   *
   * **この経路にしか置かない**のが重要で、`session.lost` (クラッシュ・切断) では
   * done にしない。 落ちただけのセッションでタスクが消えると、 残作業が見えなくなる。
   */
  memoria?: { completeTask?(id: number): Promise<void> };
}

export interface SessionEndFlowResult {
  /**
   * 生成済 report 行. 生成に失敗した場合は null.
   *
   * {@link runSessionEndFlow} は report 生成を待たないため **常に null** を返す。
   * 実際の値を得るのは {@link generateAndPostReport} を直接 await したときだけ
   * (テスト用)。 運用経路では `repo.findReport(id)` で後から読む。
   */
  report: SessionReportRow | null;
  /** #報告 channel に投稿した chat_message_id. 投稿しなかった場合は null. */
  postedMessageId: number | null;
}

/**
 * 終了済 (status=ended) session の終了処理を確定させる.
 *
 * **LLM を呼ばない**: Memoria タスク完了と session.ended emit だけを同期で行い、
 * report 生成 + 独白投稿は {@link scheduleSessionReport} へ委ねて即座に返る。
 * 戻り値の `report` / `postedMessageId` は常に null になる (生成は非同期のため)。
 * 生成後の report は `repo.findReport(id)` で読める。
 *
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

  // 1. spawn で紐付いた Memoria タスクを完了にする。 正常終了の経路だけがここを通る。
  await completeLinkedMemoriaTask(deps, endedSession);

  // 2. session.ended event。 report.generated は生成側 (非同期) が出す。
  eventBus.emit({ type: "session.ended", session_id: id, ts: now });

  // 3〜5 (generateReport + 独白投稿 + report.generated) は await しない。
  // 子プロセスを待って DELETE /v1/sessions の応答を十数秒保留しないため。
  scheduleSessionReport(deps, endedSession);

  // report はこの時点では未生成。 呼び出し元は report を使っていないが、
  // 型互換のため null を返す (生成後の値は repo.findReport で読める)。
  return { report: null, postedMessageId: null };
}

/**
 * report 生成 + 独白投稿を **リクエストパスの外** で走らせる (fire-and-forget)。
 *
 * `claude -p` を 2 回直列で起動するため十数秒かかる。 呼び出し元は await しない。
 * 失敗しても session 終了は既に確定しているので、 warn を残して握り潰す。
 *
 * 同一 session に対する二重生成を防ぐため、 進行中の id を集合で持つ。
 */
const reportInFlight = new Set<string>();

export function scheduleSessionReport(deps: EndSessionFlowDeps, endedSession: SessionRow): void {
  const id = endedSession.id;
  if (reportInFlight.has(id)) return;
  reportInFlight.add(id);
  setImmediate(() => {
    void generateAndPostReport(deps, endedSession)
      .catch((err) => {
        log.warn({ session_id: id, err: (err as Error).message }, "deferred session report failed");
      })
      .finally(() => {
        reportInFlight.delete(id);
      });
  });
}

/**
 * report 生成と独白投稿の本体。 {@link scheduleSessionReport} から非同期で呼ばれる。
 *
 * テストからは await して決定的に検証できるよう export しておく。
 */
export async function generateAndPostReport(
  deps: EndSessionFlowDeps,
  endedSession: SessionRow,
): Promise<SessionEndFlowResult> {
  const id = endedSession.id;
  const now = endedSession.ended_at ?? Math.floor(Date.now() / 1000);

  // report 用の構造化集計 (+ dispatcher.onSessionEnd は no-op: 独白は report 経路)
  let bullets: object = {};
  try {
    const events = deps.repo.allEvents(id);
    bullets = aggregateBullets(endedSession, events);
  } catch (err) {
    log.warn({ session_id: id, err: (err as Error).message }, "aggregateBullets failed");
  }

  // 3. generateReport — claude CLI を叩くので落ちうる. 失敗時は report=null で続行.
  let report: SessionReportRow | null = null;
  try {
    const events = deps.repo.allEvents(id);
    report = await generateReport(endedSession, events, {
      harnessAudit: deps.harnessAudit,
      usageFrames: deps.usageFrames,
      questionState: deps.questionState,
    });
    deps.repo.upsertReport(report);
  } catch (err) {
    log.warn(
      { session_id: id, err: (err as Error).message },
      "generateReport failed; session end completes without per-session report",
    );
  }

  // 4. 独白を #報告 channel に投稿 (report が生成できた時だけ)
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
        eventBus.emit({
          type: "chat.posted",
          message_id: msg.id,
          channel: msg.channel,
          author_label: msg.author_label,
          session_id: msg.session_id,
          ts: msg.ts,
          is_actionable: false,
        });
      } catch (err) {
        log.warn({ session_id: id, err: (err as Error).message }, "monologue post failed");
      }
    }
  }

  // 5. report.generated event
  if (report) {
    eventBus.emit({ type: "report.generated", session_id: id, ts: now });
  }

  return { report, postedMessageId };
}

/**
 * セッション metadata の `memoria_task_id` を読み、そのタスクを done にする。
 *
 * 失敗は握って warn に留める — タスク管理の都合でセッション終了処理を落とさない。
 */
export async function completeLinkedMemoriaTask(
  deps: Pick<EndSessionFlowDeps, "memoria">,
  session: Pick<SessionRow, "id" | "metadata">,
): Promise<number | null> {
  const completeTask = deps.memoria?.completeTask;
  if (!completeTask) return null;
  const taskId = readMemoriaTaskId(session.metadata);
  if (taskId === null) return null;
  try {
    await completeTask.call(deps.memoria, taskId);
    log.info({ session_id: session.id, task_id: taskId }, "memoria task completed on session end");
    return taskId;
  } catch (err) {
    log.warn(
      { session_id: session.id, task_id: taskId, err: (err as Error).message },
      "memoria task completion failed",
    );
    return null;
  }
}

/** metadata は TEXT 列なので JSON として読めないことがある。 読めなければ紐付け無しとみなす。 */
function readMemoriaTaskId(metadata: unknown): number | null {
  const raw = typeof metadata === "string"
    ? (() => {
        try {
          return JSON.parse(metadata) as unknown;
        } catch {
          return null;
        }
      })()
    : metadata;
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as { memoria_task_id?: unknown }).memoria_task_id;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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
