/**
 * 自動確認の巡回ごとに、セッションの「人間のやること」を照合して報告する use case。
 *
 * - 報告要否は human-todo-digest の純関数で決める。ここは状態の読み出しと、報告済み
 *   要約値の記録 (claim)、Discord 配信境界へのイベント発行だけを行う。
 * - 記録はイベント発行より先に同期で行う。巡回が重なっても同じ内容を二重に送らない。
 * - 配信に失敗したら配信側が releaseHumanTodoReport で記録を戻し、次の巡回で再送する。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2 人間のやることの報告
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { eventBus } from "../events.js";
import { readHumanWait } from "./human-wait.js";
import {
  HUMAN_TODO_REPORT_KEY,
  collectHumanTodos,
  decideHumanTodoReport,
  readHumanTodoReport,
  renderHumanTodoReport,
  renderHumanTodoResolved,
  type HumanTodoQuestion,
  type HumanTodoReportDecision,
} from "./human-todo-digest.js";

export const HUMAN_TODO_REPORT_SOURCE = "auto:human-todo-report";

export interface HumanTodoReportDeps {
  repo: Pick<SessionsRepo, "findSession" | "updateMetadata">;
  /** そのセッションの未回答質問カード (古い順)。 */
  listUnansweredQuestions: (sessionId: string) => readonly HumanTodoQuestion[];
  now?: () => number;
}

export function reportHumanTodos(deps: HumanTodoReportDeps, session: SessionRow): HumanTodoReportDecision {
  const latest = deps.repo.findSession(session.id);
  if (!latest || latest.status !== "active") return { kind: "none" };
  const items = collectHumanTodos({
    humanWait: readHumanWait(latest.metadata),
    questions: deps.listUnansweredQuestions(latest.id),
  });
  const decision = decideHumanTodoReport({ items, last: readHumanTodoReport(latest.metadata) });
  const nowMs = (deps.now ?? Date.now)();
  if (decision.kind === "report") {
    const record = { digest: decision.digest, count: items.length, reported_at: nowMs };
    deps.repo.updateMetadata(latest.id, (metadata) => ({ ...metadata, [HUMAN_TODO_REPORT_KEY]: record }));
    eventBus.emit({
      type: "session.human_todos_changed",
      target_session_id: latest.id,
      change: "report",
      digest: decision.digest,
      item_count: items.length,
      text: renderHumanTodoReport(items),
      ts: Math.floor(nowMs / 1000),
    });
  } else if (decision.kind === "resolved") {
    deps.repo.updateMetadata(latest.id, (metadata) => ({ ...metadata, [HUMAN_TODO_REPORT_KEY]: null }));
    eventBus.emit({
      type: "session.human_todos_changed",
      target_session_id: latest.id,
      change: "resolved",
      digest: null,
      item_count: 0,
      text: renderHumanTodoResolved(),
      ts: Math.floor(nowMs / 1000),
    });
  }
  return decision;
}

/**
 * 配信できなかった報告の記録を戻す。記録がその後別の内容に更新されていれば触らない
 * (新しい報告の記録を古い配信失敗で消さない)。
 */
export function releaseHumanTodoReport(
  repo: Pick<SessionsRepo, "updateMetadata">,
  sessionId: string,
  digest: string,
): void {
  repo.updateMetadata(sessionId, (metadata) => {
    const current = metadata[HUMAN_TODO_REPORT_KEY] as { digest?: unknown } | null | undefined;
    if (!current || current.digest !== digest) return metadata;
    return { ...metadata, [HUMAN_TODO_REPORT_KEY]: null };
  });
}
