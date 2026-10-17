/**
 * 「人間のやること」の報告済み記録 (session metadata) のキーと、 配信失敗時の記録の巻き戻し。
 *
 * 記録は control 側 (human-todo-report.ts) が付け、 巻き戻しは Discord 配信側 (discord/human-todo-post.ts)
 * が送信に失敗したときに行う。 chat 層は control 層を import しないので、 両者が使う最小の部品だけを
 * ここへ置く。 公開名は control 側からも再エクスポートする。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2 人間のやることの報告
 */
import type { SessionsRepo } from "../db/sessions-repo.js";

/** 報告済みの要約値を記録する session metadata キー。 */
export const HUMAN_TODO_REPORT_KEY = "cc_human_todo_report";

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
