/**
 * 確認の use case: 証跡を集め、 ワンショット判定を 1 回呼び、 カードを更新し、 不調なら通知を積む。
 *
 * @implements spec/feature/daily-goal-run.md — 4. 1 時間ごとのワンショット確認 / 5. 不調の通知 / CC-DG-INV-02 / CC-DG-INV-03 / CC-DG-INV-05 / CC-DG-INV-07 / CC-DG-INV-12
 *
 * セッションへは何も送らない。 判定の失敗は「判定できず」として記録し、 通知も続き具合の変更もしない
 * (次の確認でまた試す)。 到達は判定が挙げた実在の証跡で照合し、 そろえば finisher が止める。
 * 通知するか・続き具合の更新は alert-policy が決め、 続き具合は CAS で書いてから通知を積む。
 */

import { randomUUID } from "node:crypto";
import { deadlineOf } from "./business-day.js";
import { decideProgressAlert } from "./alert-policy.js";
import { buildAlertText } from "./card.js";
import { isCheckpointDue, normalizeJudgment, reachedByJudgment } from "./judgment-policy.js";
import { ACTIVE_GOAL_STATUSES, VERDICT_LABELS, isActiveGoal, type DailyGoal, type EvidenceSnapshot } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";

export type CheckpointOutcome = "on_track" | "behind" | "stalled" | "reached" | "failed" | "not_active";

export interface CheckpointFinisher {
  markReached(goalId: string, now: number): boolean;
}

export class DailyGoalCheckpointer {
  /** 同じゴールの確認を重ねない (判定を同じ確認で 2 回呼ばない、 CC-DG-INV-02)。 */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: DailyGoalServiceDeps,
    private readonly touch: (goalId: string, line?: string) => void,
    private readonly finisher: CheckpointFinisher,
  ) {}

  /** 期限が来た見守り中のゴールを確認する。 */
  async runDue(now: number): Promise<void> {
    const { checkpointMinutes } = this.deps.config();
    for (const goal of this.deps.repo.listByStatus(ACTIVE_GOAL_STATUSES)) {
      const last = this.deps.repo.lastCheckpoint(goal.id);
      if (!isCheckpointDue(goal, last?.at ?? null, now, checkpointMinutes)) continue;
      try { await this.run(goal.id, now); }
      catch (error) { this.deps.log?.warn(`daily goal checkpoint failed goal=${goal.id}: ${String(error)}`); }
    }
  }

  async run(goalId: string, now: number): Promise<CheckpointOutcome> {
    if (this.inFlight.has(goalId)) return "not_active";
    this.inFlight.add(goalId);
    try { return await this.check(goalId, now); }
    finally { this.inFlight.delete(goalId); }
  }

  private async check(goalId: string, now: number): Promise<CheckpointOutcome> {
    const goal = this.deps.repo.byId(goalId);
    if (!goal || !isActiveGoal(goal)) return "not_active";
    const previous = this.deps.repo.lastCheckpoint(goal.id, ["judgment", "judge_failed", "progress", "completion"]);
    const evidence = await this.collect(goal);
    const result = await this.deps.judge.judge({
      goalText: goal.goalText, acceptance: goal.acceptance, evidence,
      elapsedMinutes: (now - goal.confirmedAt) / 60_000,
      remainingMinutes: (deadlineOf(goal.date, this.deps.config().dayBoundary) - now) / 60_000,
    });
    // 判定の間に停止・締切で止まっていれば何もしない。
    const latest = this.deps.repo.byId(goal.id);
    if (!latest || !isActiveGoal(latest)) return "not_active";
    const id = (this.deps.newId ?? randomUUID)();
    const known = new Set(previous?.evidence.items.map((item) => item.key) ?? []);
    const progress = evidence.items.some((item) => !known.has(item.key));
    const judgment = result.ok ? normalizeJudgment(result.raw, goal.acceptance, evidence) : null;
    if (!judgment) {
      const error = result.ok ? "判定の結果を解釈できませんでした" : result.error;
      this.deps.repo.addCheckpoint({ id, goalId: goal.id, at: now, kind: "judge_failed", evidence, progress, report: error.slice(0, 500), decision: "go", judgment: null });
      this.touch(goal.id, `確認: 判定できず (${error.slice(0, 80)})。通知せず、次の確認でまた試します`);
      return "failed";
    }
    const reached = reachedByJudgment(goal, judgment);
    this.deps.repo.setAcceptanceProgress(goal.id, reached.progress, now);
    this.deps.repo.addCheckpoint({ id, goalId: goal.id, at: now, kind: "judgment", evidence, progress, report: null, decision: reached.reached ? "reached" : "go", judgment });
    const unavailable = evidence.unavailable.length ? ` (未取得: ${evidence.unavailable.join(", ")})` : "";
    if (reached.reached) {
      this.touch(goal.id, `確認: 受入条件の全項目に到達の証跡があります${unavailable}`);
      this.finisher.markReached(goal.id, now);
      return "reached";
    }
    this.touch(goal.id, `確認: ${VERDICT_LABELS[judgment.verdict]} — ${judgment.reason.slice(0, 120)}${unavailable}`);
    const state = { streakSince: latest.alertStreakSince ?? null, count: latest.alertCount };
    const decision = decideProgressAlert(state, judgment.verdict, now);
    const changed = decision.next.streakSince !== state.streakSince || decision.next.count !== state.count;
    if (changed && !this.deps.repo.setAlertState(goal.id, state, decision.next, now)) return judgment.verdict;
    if (decision.notify) {
      this.deps.alerts.add({
        id: (this.deps.newId ?? randomUUID)(), goalId: goal.id, at: now, kind: decision.kind, verdict: judgment.verdict,
        text: buildAlertText(latest, judgment, decision.kind), mentionUserId: goal.confirmedBy.userId,
      });
      this.touch(goal.id, decision.kind === "repeat" ? "不調が 3 時間続いたため、投稿者に再通知します" : "進み具合が芳しくないため、投稿者に通知します");
    }
    return judgment.verdict;
  }

  /** 証跡を集める。 集められなくても判定は呼ぶ (未取得として資料に載せる)。 */
  private async collect(goal: DailyGoal): Promise<EvidenceSnapshot> {
    try { return await this.deps.evidence.collect(goal, goal.confirmedAt); }
    catch (error) {
      this.deps.log?.warn(`daily goal evidence failed goal=${goal.id}: ${String(error)}`);
      return { items: [], taskStatuses: {}, unavailable: ["evidence"] };
    }
  }
}
