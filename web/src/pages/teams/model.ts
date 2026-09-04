/**
 * Teams ページの純ロジック (kanban 分類 / メトリクス整形 / チームフィルタ補助)。
 * 描画コンポーネントから切り離して単体テストする (activity-chat.ts の流儀)。
 */

import type { DirectorCaseSummary, DirectorStepStatus } from "../../api.js";

export type CaseColumn = "pending" | "active" | "blocked" | "completed" | "cancelled";

export const CASE_COLUMNS: Array<{ key: CaseColumn; label: string }> = [
  { key: "pending", label: "未着手" },
  { key: "active", label: "進行中" },
  { key: "blocked", label: "ブロック" },
  { key: "completed", label: "完了" },
  { key: "cancelled", label: "中止" },
];

/**
 * step 群から case の kanban 列を決める。
 * blocked が最優先、 次に「着手済みで未完了」= active。 全 step 終端なら completed / cancelled。
 */
export function deriveCaseColumn(steps: ReadonlyArray<{ status: DirectorStepStatus }>): CaseColumn {
  if (steps.length === 0) return "pending";
  const statuses = steps.map((step) => step.status);
  if (statuses.includes("blocked")) return "blocked";
  const terminal = statuses.every((status) => status === "completed" || status === "cancelled");
  if (terminal) return statuses.includes("completed") ? "completed" : "cancelled";
  if (statuses.includes("active") || statuses.includes("completed") || statuses.includes("cancelled")) {
    return "active";
  }
  return "pending";
}

export function groupCasesByColumn(
  cases: readonly DirectorCaseSummary[],
): Record<CaseColumn, DirectorCaseSummary[]> {
  const grouped: Record<CaseColumn, DirectorCaseSummary[]> = {
    pending: [], active: [], blocked: [], completed: [], cancelled: [],
  };
  for (const entry of cases) grouped[deriveCaseColumn(entry.steps)].push(entry);
  return grouped;
}

/**
 * 止まっている工程を case 横断で拾う。
 *
 * kanban の「ブロック」列は case を出すだけで、 **どの工程が何で止まっているか**は
 * カードを開かないと分からない。 受け入れ基準は「1 画面で分かる」なので、
 * 工程単位に開いて理由ごと並べる (spec/feature/director-goal-flow.md 受け入れ基準 4)。
 */
export interface BlockedStepSummary {
  caseId: string;
  caseTitle: string;
  caseUpdatedAt: number;
  project: string;
  step: DirectorCaseSummary["steps"][number];
}

export function blockedSteps(
  cases: readonly DirectorCaseSummary[],
): BlockedStepSummary[] {
  const out: BlockedStepSummary[] = [];
  for (const entry of cases) {
    for (const step of entry.steps) {
      if (step.status !== "blocked") continue;
      out.push({
        caseId: entry.case.id,
        caseTitle: entry.case.title,
        caseUpdatedAt: entry.case.updated_at,
        project: entry.case.project,
        step,
      });
    }
  }
  // 更新が古い case を先に見せる (放置されているものから)。
  return out.sort((left, right) =>
    left.caseUpdatedAt - right.caseUpdatedAt || left.step.sequence - right.step.sequence
  );
}

/** 一覧へ出してよい blocked 事由を表示文へ変換する。 */
export function blockedReasonLabel(
  reason: DirectorCaseSummary["steps"][number]["blocked_reason"],
): string {
  switch (reason) {
    case "run-missing": return "委託 run が見つからない";
    case "run-failed": return "委託 run が失敗";
    case "human-decision": return "人間の判断待ち";
    case "internal-note": return "詳細はケース内の記録を確認";
    case "not-recorded":
    case null: return "理由の記録なし";
  }
}

/** case 内の進捗 (完了 step / 全 step)。 */
export function caseProgress(steps: ReadonlyArray<{ status: DirectorStepStatus }>): string {
  const done = steps.filter((step) => step.status === "completed").length;
  return `${done}/${steps.length}`;
}

/** トークン数の短表記 (1234 → 1.2k)。 カードのメトリクス用。 */
export function fmtTokensShort(value: number): string {
  const tokens = Math.max(0, Math.floor(value));
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return (tokens / 1000).toFixed(1) + "k";
  return (tokens / 1_000_000).toFixed(2) + "M";
}

/** CostFeed のチャンネル表をチーム所属セッションだけに絞る (チームフィルタ用)。 */
export function filterChannelsByTeam<T extends { sessionId: string }>(
  channels: readonly T[],
  teamSessionIds: ReadonlyArray<string> | null,
): T[] {
  if (teamSessionIds === null) return [...channels];
  const ids = new Set(teamSessionIds);
  return channels.filter((channel) => ids.has(channel.sessionId));
}

/** 改行区切りのリポジトリ入力 → 正規化配列 (空行除去 + trim)。 */
export function parseRepoLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}
