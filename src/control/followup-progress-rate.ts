/**
 * FU-RATE: 自動確認の進捗率 (0〜100) を作業項目から決定的に計算する純関数。
 * 作業項目 = 紐付いた Actio タスク + このセッションが提出した PR。項目が無ければ null (未計測)。
 * merged 後の反映は Cc が観測できないため、PR は merged でも 90 に留める (完了の断定には使わない)。
 *
 * @implements spec/feature/autonomous-work-continuation.md FU-RATE
 */
import type { SessionFollowupSnapshot } from "./session-followup-state.js";

const TASK_RATE: Record<string, number> = { open: 0, in_progress: 30, blocked: 30, done: 100 };

function prRate(pr: { status: string; checkStatus: string }): number | null {
  if (pr.status === "merged") return 90;
  if (pr.status !== "open") return null; // closed など決着済みで成果にならないものは数えない
  if (pr.checkStatus === "test_ok") return 80;
  if (pr.checkStatus === "failed" || pr.checkStatus === "action_required") return 50;
  return 60;
}

export function computeFollowupProgressRate(snapshot: SessionFollowupSnapshot | undefined): number | null {
  if (!snapshot) return null;
  const values: number[] = [];
  for (const task of snapshot.tasks) {
    const value = TASK_RATE[task.status];
    if (value !== undefined) values.push(value);
  }
  for (const pr of snapshot.prs) {
    const value = prRate(pr);
    if (value !== null) values.push(value);
  }
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** 本文に載せる 1 行。 */
export function renderProgressRate(rate: number | null): string {
  return rate === null ? "進捗率: 未計測 (Actio タスク・PR の作業項目がありません)" : `進捗率: ${rate}%`;
}
