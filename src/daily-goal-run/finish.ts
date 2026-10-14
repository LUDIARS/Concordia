/**
 * 止まる条件の use case: ゴール到達・人間の停止・締切。
 *
 * @implements spec/feature/daily-goal-run.md — 6. 終わり方 / CC-DG-INV-03 / CC-DG-INV-05 / CC-DG-INV-08
 *
 * 到達は checkpoint が判定と実在の証跡で照合してから呼ぶ。 締切は day-close が締切を判定してから
 * 呼ぶ (ここは時刻を判断しない)。 最後の証跡を集め、 受入条件ごとの到達を記録してから止める。
 * セッションには触らない (旧方式の専用セッションも自動で止めない)。
 */

import { randomUUID } from "node:crypto";
import { canHumanStop } from "./stop-policy.js";
import { capabilityAllowed } from "../staff/roles.js";
import { DailyGoalConflict, isActiveGoal, type DailyGoal, type EvidenceSnapshot, type GoalActor } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";

const STOP_LABELS = { achieved: "達成", stopped: "停止", deadline: "締切" } as const;

export class DailyGoalFinisher {
  constructor(
    private readonly deps: DailyGoalServiceDeps,
    private readonly touch: (goalId: string, line?: string) => void,
  ) {}

  /** ゴール到達。 照合は checkpoint が済ませている。 既に止まっていれば false。 */
  markReached(goalId: string, now: number): boolean {
    const goal = this.deps.repo.byId(goalId);
    if (!goal || !isActiveGoal(goal)) return false;
    return this.close(goal, "achieved", now, { reason: "goal_reached" });
  }

  /**
   * 締切での停止。 最後の証跡を集め、 受入条件ごとに記録済みの到達 (実在する証跡の参照) を
   * 残してから止める。 証跡が集められなくても止める (締切は止まる条件)。
   */
  async stopByDeadline(goalId: string, now: number): Promise<DailyGoal | null> {
    const goal = this.deps.repo.byId(goalId);
    if (!goal || !isActiveGoal(goal)) return null;
    let evidence: EvidenceSnapshot = { items: [], taskStatuses: {}, unavailable: ["evidence"] };
    try { evidence = await this.deps.evidence.collect(goal, goal.confirmedAt); }
    catch (error) { this.deps.log?.warn(`daily goal deadline evidence failed goal=${goal.id}: ${String(error)}`); }
    const known = new Set(evidence.items.map((item) => item.key));
    const progress = Object.fromEntries(goal.acceptance.map((item) => [item, (goal.acceptanceProgress?.[item] ?? []).filter((ref) => known.has(ref))]));
    this.deps.repo.setAcceptanceProgress(goal.id, progress, now);
    this.deps.repo.addCheckpoint({
      id: (this.deps.newId ?? randomUUID)(), goalId: goal.id, at: now, kind: "deadline", evidence, progress: false, report: null, decision: "deadline", judgment: null,
    });
    const reached = Object.values(progress).filter((refs) => refs.length > 0).length;
    if (this.close(goal, "deadline", now, { reason: "deadline" })) {
      this.touch(goal.id, `締切: 受入条件 ${goal.acceptance.length} 件中 ${reached} 件に到達の証跡があります`);
    }
    return this.deps.repo.byId(goal.id);
  }

  /** 人間本人の停止。 登録した本人か session_control (管理職以上)。 */
  stopByHuman(goalId: string, actor: GoalActor, now: number): DailyGoal {
    const goal = this.deps.repo.byId(goalId);
    if (!goal) throw new DailyGoalConflict("デイリーゴールが見つかりません。", "not_found");
    const allowed = canHumanStop({
      isHuman: !actor.isBot && !actor.isWebhook && !!actor.userId,
      isConfirmer: actor.userId === goal.confirmedBy.userId,
      hasSessionControl: capabilityAllowed(actor.role, "session_control"),
    });
    if (!allowed) throw new DailyGoalConflict("停止できるのは登録した本人か管理職以上です。", "forbidden");
    if (!isActiveGoal(goal)) throw new DailyGoalConflict(`このゴールは既に ${goal.status} です。`, "not_running");
    if (!this.close(goal, "stopped", now, { reason: "human_stop", by: actor.userId })) {
      throw new DailyGoalConflict("このゴールは既に終了しています。", "not_running");
    }
    return this.deps.repo.byId(goal.id)!;
  }

  private close(goal: DailyGoal, status: keyof typeof STOP_LABELS, now: number,
    input: { reason: "goal_reached" | "human_stop" | "deadline"; by?: string }): boolean {
    if (!this.deps.repo.finish(goal.id, { status, reason: input.reason, by: input.by ?? null, now })) return false;
    this.touch(goal.id, `${STOP_LABELS[status]}: ${input.reason === "human_stop" ? `<@${input.by}> が停止しました` : "止まる条件を照合しました"}`);
    return true;
  }
}
