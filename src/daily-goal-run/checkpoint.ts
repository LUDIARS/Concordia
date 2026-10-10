/**
 * 確認の use case: 証跡を集め、 進捗を判定し、 確認の inject とカードの更新を行う。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 1 時間ごとの確認 / 予算 / CC-DG-INV-03 / CC-DG-INV-05 / CC-DG-INV-07
 *
 * 送る直前に回答待ちを確かめ、 待ちなら inject も予算のリセットもしない。
 * 予算のリセットは進捗ありの確認でだけ行う (完了確認の doable は finish.ts が扱う)。
 */

import { randomUUID } from "node:crypto";
import { isCheckpointDue, planCheckpoint } from "./checkpoint-policy.js";
import { buildCompletionCheckPrompt, buildProgressCheckPrompt } from "./prompts.js";
import type { DailyGoal } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";

export class DailyGoalCheckpointer {
  constructor(
    private readonly deps: DailyGoalServiceDeps,
    private readonly touch: (goalId: string, line?: string) => void,
    private readonly onLost: (sessionId: string, now: number) => void,
  ) {}

  /** 期限が来た running ゴールを確認する。 */
  async runDue(now: number): Promise<void> {
    const { checkpointMinutes } = this.deps.config();
    for (const goal of this.deps.repo.listByStatus(["running"])) {
      const last = this.deps.repo.lastCheckpoint(goal.id);
      if (isCheckpointDue(goal, last?.at ?? null, now, checkpointMinutes)) await this.run(goal.id, now);
    }
  }

  async run(goalId: string, now: number): Promise<"skipped_waiting" | "progress" | "completion" | "not_running"> {
    const goal = this.deps.repo.byId(goalId);
    if (!goal || goal.status !== "running" || !goal.sessionId) return "not_running";
    const session = this.deps.sessions.find(goal.sessionId);
    if (!session || session.status === "ended" || session.status === "lost") {
      this.onLost(goal.sessionId, now);
      return "not_running";
    }
    const previous = this.deps.repo.lastCheckpoint(goal.id, ["progress", "completion"]);
    if (this.deps.waiting.isWaiting(goal.sessionId)) return this.skipWaiting(goal, previous?.evidence ?? null, now);
    const current = await this.deps.evidence.collect(goal, goal.launchedAt ?? goal.confirmedAt);
    // 証跡収集の間に状態が変わっていれば何もしない (停止・喪失・回答待ちの後に送らない)。
    const latest = this.deps.repo.byId(goal.id);
    if (!latest || latest.status !== "running") return "not_running";
    const plan = planCheckpoint({ waiting: this.deps.waiting.isWaiting(goal.sessionId), previous: previous?.evidence ?? null, current });
    if (plan.action === "skip_waiting") return this.skipWaiting(goal, previous?.evidence ?? null, now);
    const id = (this.deps.newId ?? randomUUID)();
    const unavailable = current.unavailable.length ? ` (未取得: ${current.unavailable.join(", ")})` : "";
    if (plan.action === "progress") {
      this.deps.repo.addCheckpoint({ id, goalId: goal.id, at: now, kind: "progress", evidence: current, progress: true, report: null, decision: "go" });
      this.deps.inject.inject(goal.sessionId, buildProgressCheckPrompt(goal, plan.newEvidence, this.deps.baseUrl));
      this.deps.autonomy.resetBudget(goal.sessionId);
      this.touch(goal.id, `確認: 進捗あり (証跡 +${plan.newEvidence.length})${unavailable}。続行`);
      return "progress";
    }
    this.deps.repo.addCheckpoint({ id, goalId: goal.id, at: now, kind: "completion", evidence: current, progress: false, report: null, decision: "pending" });
    this.deps.inject.inject(goal.sessionId, buildCompletionCheckPrompt(goal, this.deps.baseUrl));
    this.touch(goal.id, `確認: 進捗なし${unavailable}。完了確認を送りました (止めません)`);
    return "completion";
  }

  /** 回答待ち: inject を送らず予算も戻さない。 催促 (タイムライン) は待ちに入った 1 回だけ。 */
  private skipWaiting(goal: DailyGoal, previous: import("./domain.js").EvidenceSnapshot | null, now: number): "skipped_waiting" {
    const last = this.deps.repo.lastCheckpoint(goal.id);
    const first = last?.kind !== "skipped_waiting";
    this.deps.repo.addCheckpoint({
      id: (this.deps.newId ?? randomUUID)(), goalId: goal.id, at: now, kind: "skipped_waiting",
      evidence: previous ?? { items: [], taskStatuses: {}, unavailable: [] }, progress: false, report: null, decision: "waiting",
    });
    this.touch(goal.id, first ? "回答待ちのため確認を送りませんでした。回答をお願いします" : undefined);
    return "skipped_waiting";
  }
}
