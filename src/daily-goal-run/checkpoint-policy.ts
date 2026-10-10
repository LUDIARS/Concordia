/**
 * 1 時間ごとの確認の判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 1 時間ごとの確認 / CC-DG-INV-03 / CC-DG-INV-05 / CC-DG-INV-07
 *
 * 進捗は Cc が集めた証跡の差分だけで判定する (セッションの自己申告は数えない)。
 * 進捗ありなら「進捗確認」、 無ければ「完了確認」を送る。 進捗なしでも止めない。
 * 未回答の質問 / 人間待ちの間は送らず、 予算も戻さない。
 */

import type { DailyGoal, EvidenceSnapshot } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:33d0514b */
import augurContract_8ab9a86e from './plan-checkpoint.contract.js'; /* augur-inject:contract-predicate:441d79e8 */

export const DEFAULT_CHECKPOINT_MINUTES = 60;

export type CheckpointPlan =
  | { action: "skip_waiting" }
  | { action: "progress"; newEvidence: string[]; resetBudget: true }
  | { action: "completion"; newEvidence: []; resetBudget: false };

/** 前回の確認以降に増えた証跡のキー。 Actio task の状態変化もここで差分にする。 */
export function newEvidenceKeys(previous: EvidenceSnapshot | null, current: EvidenceSnapshot): string[] {
  const known = new Set(previous?.items.map((item) => item.key) ?? []);
  const added = current.items.filter((item) => !known.has(item.key)).map((item) => item.key);
  for (const [taskId, status] of Object.entries(current.taskStatuses)) {
    if (status === "unknown") continue;
    const before = previous?.taskStatuses[taskId];
    if (before !== undefined && before !== status && before !== "unknown") added.push(`actio:${taskId}:${status}`);
  }
  return [...new Set(added)];
}

/**
 * 確認で何をするかを決める。 waiting (未回答の質問・人間待ち) なら送らない。
 * 証跡が 1 件以上増えていれば進捗あり (予算を戻す)、 増えていなければ完了確認 (予算は戻さない)。
 */
export function planCheckpoint(input: {
  waiting: boolean;
  previous: EvidenceSnapshot | null;
  current: EvidenceSnapshot;
}): CheckpointPlan {
  if (input.waiting) return { action: "skip_waiting" };
  const added = newEvidenceKeys(input.previous, input.current);
  if (added.length > 0) return { action: "progress", newEvidence: added, resetBudget: true };
  return { action: "completion", newEvidence: [], resetBudget: false };
}
// @ts-expect-error augur-inject
planCheckpoint = contract(planCheckpoint, { ...augurContract_8ab9a86e, contractId: 'dg-C-4', mode: 'observe', sample: 1, where: 'src/daily-goal-run/checkpoint-policy.ts:36', rule: 'contract-wrap', id: '8ab9a86e' }); /* augur-inject:contract-wrap:8ab9a86e */

/** 確認の期限が来ているか。 起点は前回の確認、 無ければ起動時刻。 時刻で止める判断はしない。 */
export function isCheckpointDue(goal: DailyGoal, lastCheckpointAt: number | null, now: number, minutes: number): boolean {
  if (goal.status !== "running" || !goal.sessionId) return false;
  const base = lastCheckpointAt ?? goal.launchedAt;
  if (base === undefined) return false;
  return now - base >= Math.max(1, minutes) * 60_000;
}

/** 回答待ちのカード表示用の経過分。 */
export function waitingMinutes(since: number | null, now: number): number {
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 60_000));
}
