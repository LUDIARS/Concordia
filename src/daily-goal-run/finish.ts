/**
 * 止まる条件の use case: ゴール到達・十分にこなした・人間の停止・締切、 と喪失の記録。
 *
 * @implements spec/feature/daily-goal-run.md — 6. 終わり方 / 予算 / CC-DG-INV-03 / CC-DG-INV-05 / CC-DG-INV-06 / CC-DG-INV-08
 *
 * 到達は Cc が集めた証跡で照合し、 自己申告だけでは認めない。 やり切りは残りの一つずつを
 * 照合し、 doable が残れば拒否して続行 (GO) を返す。 その拒否が完了確認への返答なら、
 * そのときだけ Goal & Go の予算を戻す (CC-WM-INV-03 で許す唯一の緩和)。
 * 締切は day-close が締切を判定してから呼ぶ (ここは時刻を判断しない)。 最後の証跡を集め、
 * 受入条件ごとの到達を記録してから止める。
 */

import { randomUUID } from "node:crypto";
import { canHumanStop, evaluateExhausted, evaluateGoalReached } from "./stop-policy.js";
import { buildGoAfterRejectionPrompt, buildStoppedNotice } from "./prompts.js";
import { releaseGoalFromMetadata } from "./session-binding.js";
import { capabilityAllowed } from "../staff/roles.js";
import { DailyGoalConflict, type DailyGoal, type GoalActor, type RemainingItem } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";

export interface EvidenceClaim { item: string; refs: string[] }

export type ReachedOutcome =
  | { outcome: "reached" }
  | { outcome: "go"; missing: string[]; unverified: string[] };

export type ExhaustedOutcome =
  | { outcome: "exhausted" }
  | { outcome: "go"; doable: string[]; budgetReset: boolean }
  | { outcome: "rejected"; invalid: string[] };

export class DailyGoalFinisher {
  constructor(
    private readonly deps: DailyGoalServiceDeps,
    private readonly touch: (goalId: string, line?: string) => void,
  ) {}

  /** 呼べるのは紐付いた専用セッションだけ。 */
  private boundGoal(goalId: string, sessionId: string): DailyGoal & { sessionId: string } {
    const goal = this.deps.repo.byId(goalId);
    if (!goal) throw new DailyGoalConflict("デイリーゴールが見つかりません。", "not_found");
    if (!goal.sessionId || goal.sessionId !== sessionId) throw new DailyGoalConflict("このゴールに紐付いた専用セッションではありません。", "forbidden");
    if (goal.status !== "running") throw new DailyGoalConflict(`このゴールは既に ${goal.status} です。`, "not_running");
    return goal as DailyGoal & { sessionId: string };
  }

  async reportReached(goalId: string, sessionId: string, claims: readonly EvidenceClaim[], now: number): Promise<ReachedOutcome> {
    const goal = this.boundGoal(goalId, sessionId);
    const collected = await this.deps.evidence.collect(goal, goal.launchedAt ?? goal.confirmedAt);
    const known = new Set(collected.items.map((item) => item.key));
    const unverified: string[] = [];
    const byItem = new Map<string, string[]>();
    for (const claim of claims) {
      const verified = claim.refs.filter((ref) => known.has(ref));
      unverified.push(...claim.refs.filter((ref) => !known.has(ref)));
      if (goal.acceptance.includes(claim.item)) byItem.set(claim.item, [...(byItem.get(claim.item) ?? []), ...verified]);
    }
    this.deps.repo.setAcceptanceProgress(goal.id, Object.fromEntries(byItem), now);
    const result = evaluateGoalReached(goal.acceptance, byItem);
    if (!result.reached) {
      this.touch(goal.id, `到達の報告を照合: 証跡の無い受入条件が ${result.missing.length} 件あり続行`);
      this.injectIfFree(goal.sessionId, buildGoAfterRejectionPrompt(goal, `証跡を確認できない受入条件: ${result.missing.join(" / ")}`));
      return { outcome: "go", missing: result.missing, unverified };
    }
    this.decideOpenCompletion(goal.id, "reached");
    this.close(goal, "achieved", now, { reason: "goal_reached" });
    return { outcome: "reached" };
  }

  reportExhausted(goalId: string, sessionId: string, remaining: readonly RemainingItem[], now: number): ExhaustedOutcome {
    const goal = this.boundGoal(goalId, sessionId);
    const result = evaluateExhausted(remaining, (item) => item.questionId !== undefined
      ? this.deps.waiting.isUnansweredQuestion(sessionId, item.questionId)
      : this.deps.waiting.isHumanWaitActive(sessionId));
    if (result.accepted) {
      this.decideOpenCompletion(goal.id, "exhausted");
      this.close(goal, "exhausted", now, { reason: "exhausted", remaining: [...remaining] });
      return { outcome: "exhausted" };
    }
    if (result.reason === "invalid_items") {
      this.touch(goal.id, `やり切りの報告を差し戻し: ${result.invalid.length} 件の残りを照合できません`);
      return { outcome: "rejected", invalid: result.invalid };
    }
    // AI だけで進められる残りがある → 認めず続行。完了確認への返答で、回答待ちでないときだけ予算を戻す。
    const open = this.deps.repo.lastCheckpoint(goal.id);
    let budgetReset = false;
    if (open?.kind === "completion" && open.decision === "pending" && !this.deps.waiting.isWaiting(sessionId)
      && this.deps.repo.decideCheckpoint(open.id, "go", `doable: ${result.doable.join(" / ")}`.slice(0, 2000))) {
      this.deps.autonomy.resetBudget(sessionId);
      budgetReset = true;
    }
    this.touch(goal.id, `完了確認: AI だけで進められる残り ${result.doable.length} 件。続行 (GO)`);
    this.injectIfFree(sessionId, buildGoAfterRejectionPrompt(goal, `AI だけで進められる残り: ${result.doable.join(" / ")}`));
    return { outcome: "go", doable: result.doable, budgetReset };
  }

  /**
   * 締切での停止。 最後の証跡を集め、 受入条件ごとに記録済みの到達 (実在する証跡の参照) を
   * 残してから止める。 証跡が集められなくても止める (締切は止まる条件)。
   */
  async stopByDeadline(goalId: string, now: number): Promise<DailyGoal | null> {
    const goal = this.deps.repo.byId(goalId);
    if (!goal || (goal.status !== "confirmed" && goal.status !== "running")) return null;
    let evidence: import("./domain.js").EvidenceSnapshot = { items: [], taskStatuses: {}, unavailable: ["evidence"] };
    try { evidence = await this.deps.evidence.collect(goal, goal.launchedAt ?? goal.confirmedAt); }
    catch (error) { this.deps.log?.warn(`daily goal deadline evidence failed goal=${goal.id}: ${String(error)}`); }
    const known = new Set(evidence.items.map((item) => item.key));
    const progress = Object.fromEntries(goal.acceptance.map((item) => [item, (goal.acceptanceProgress?.[item] ?? []).filter((ref) => known.has(ref))]));
    this.deps.repo.setAcceptanceProgress(goal.id, progress, now);
    this.decideOpenCompletion(goal.id, "go");
    this.deps.repo.addCheckpoint({
      id: (this.deps.newId ?? randomUUID)(), goalId: goal.id, at: now, kind: "deadline", evidence, progress: false, report: null, decision: "deadline",
    });
    const reached = Object.values(progress).filter((refs) => refs.length > 0).length;
    try { this.close(goal, "deadline", now, { reason: "deadline" }); }
    catch { return this.deps.repo.byId(goal.id); }
    this.touch(goal.id, `締切: 受入条件 ${goal.acceptance.length} 件中 ${reached} 件に到達の証跡があります`);
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
    if (goal.status !== "confirmed" && goal.status !== "running") throw new DailyGoalConflict(`このゴールは既に ${goal.status} です。`, "not_running");
    this.decideOpenCompletion(goal.id, "go");
    this.close(goal, "stopped", now, { reason: "human_stop", by: actor.userId });
    return this.deps.repo.byId(goal.id)!;
  }

  /** 専用セッションの喪失。 自動で別セッションを起動しない (UX-CC-S3)。 */
  onSessionLost(sessionId: string, now: number): void {
    for (const goal of this.deps.repo.bySession(sessionId)) {
      if (this.deps.repo.finish(goal.id, { status: "lost", reason: "session_lost", now })) {
        this.touch(goal.id, "専用セッションを喪失しました。自動では再起動しません。再開は人間が選んでください");
      }
    }
  }

  private decideOpenCompletion(goalId: string, decision: "reached" | "exhausted" | "go"): void {
    const open = this.deps.repo.lastCheckpoint(goalId);
    if (open?.kind === "completion" && open.decision === "pending") this.deps.repo.decideCheckpoint(open.id, decision, null);
  }

  private close(goal: DailyGoal, status: "achieved" | "exhausted" | "stopped" | "deadline", now: number,
    input: { reason: "goal_reached" | "exhausted" | "human_stop" | "deadline"; by?: string; remaining?: RemainingItem[] }): void {
    if (!this.deps.repo.finish(goal.id, { status, reason: input.reason, by: input.by ?? null, remaining: input.remaining, now })) {
      throw new DailyGoalConflict("このゴールは既に終了しています。", "not_running");
    }
    const label = status === "achieved" ? "達成" : status === "exhausted" ? "やり切り" : status === "deadline" ? "締切" : "停止";
    this.touch(goal.id, `${label}: ${input.reason === "human_stop" ? `<@${input.by}> が停止しました` : "止まる条件を照合しました"}`);
    if (!goal.sessionId) return;
    this.deps.autonomy.disable(goal.sessionId);
    this.deps.sessions.updateMetadata(goal.sessionId, (metadata) => releaseGoalFromMetadata(metadata, goal));
    this.injectIfFree(goal.sessionId, buildStoppedNotice(goal, status));
  }

  /** 回答待ちのセッションへは自動 inject を送らない (CC-INV-08)。 */
  private injectIfFree(sessionId: string, text: string): void {
    if (this.deps.waiting.isWaiting(sessionId)) return;
    this.deps.inject.inject(sessionId, text);
  }
}
