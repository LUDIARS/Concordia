/**
 * デイリーゴールの application service (use case の窓口)。
 *
 * @implements spec/feature/daily-goal-run.md — 流れ 1〜8 / CC-DG-INV-01〜12
 *
 * 登録 (registerGoal) はここ、 投稿の読み取り・確認 (ワンショット判定と不調の通知)・終了・締切・
 * 9:00 の通知は専用モジュールへ委ねる。 セッションは起動しない。 外部 I/O は port 経由で行う。
 */

import { createHash } from "node:crypto";
import { DailyGoalCheckpointer, type CheckpointOutcome } from "./checkpoint.js";
import { DailyGoalFinisher } from "./finish.js";
import { DailyGoalPostIntake, type RegisterGoalInput } from "./post-intake.js";
import { DailyGoalDayCloser, summaryCardId } from "./day-close.js";
import { DailyGoalReminder, reminderCardId } from "./reminder.js";
import { buildDaySummaryCard, buildGoalCard, buildReminderView, type DailyGoalCardView, type DaySummaryCardView } from "./card.js";
import type { DailyGoal, DailyGoalCheckpoint, DailyGoalDay, DailyGoalDraft, GoalActor } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";
import type { DailyGoalCard, TimelineEntry } from "./repository.js";
import type { DailyGoalAlert } from "./alert-repository.js";

export interface DailyGoalDetail {
  goal: DailyGoal;
  checkpoints: DailyGoalCheckpoint[];
  timeline: TimelineEntry[];
  card: DailyGoalCard | null;
  alerts: DailyGoalAlert[];
}

export interface DailyGoalDayDetail {
  day: DailyGoalDay | null;
  goals: DailyGoal[];
  drafts: DailyGoalDraft[];
}

export type DailyGoalCardContent =
  | { kind: "goal"; goalId: string; view: DailyGoalCardView }
  | { kind: "reminder"; date: string; view: { title: string; lines: string[] } }
  | { kind: "summary"; date: string; view: DaySummaryCardView }
  | null;

/** 不調の通知の配達先。 スレッドがあればスレッド、 無ければカードへの返信。 どちらも無ければまだ送らない。 */
export interface DailyGoalAlertContent {
  text: string;
  mentionUserId: string;
  threadId: string | null;
  cardMessageId: string | null;
}

export function goalCardId(goalId: string): string { return `goal-${goalId}`; }

export class DailyGoalRunService {
  readonly intake: DailyGoalPostIntake;
  private readonly checkpointer: DailyGoalCheckpointer;
  private readonly finisher: DailyGoalFinisher;
  private readonly closer: DailyGoalDayCloser;
  private readonly reminder: DailyGoalReminder;

  constructor(readonly deps: DailyGoalServiceDeps) {
    const touch = (goalId: string, line?: string): void => this.touch(goalId, line);
    this.finisher = new DailyGoalFinisher(deps, touch);
    this.checkpointer = new DailyGoalCheckpointer(deps, touch, this.finisher);
    this.closer = new DailyGoalDayCloser(deps, this.finisher, (date) => deps.repo.touchCard(summaryCardId(date), "summary", date));
    this.reminder = new DailyGoalReminder(deps, (date) => deps.repo.touchCard(reminderCardId(date), "reminder", date));
    this.intake = new DailyGoalPostIntake(deps, (input) => this.registerGoal(input));
  }

  /** カードの版を上げ、 必要ならタイムラインに 1 行足す。 */
  private touch(goalId: string, line?: string): void {
    if (line) this.deps.repo.addTimeline(goalId, Date.now(), line);
    this.deps.repo.touchCard(goalCardId(goalId), "goal", goalId);
  }

  /**
   * 投稿から読み取りがそろったゴールの登録。 認可と許可の上限は post-intake が済ませている。
   * id は投稿 (message id) から決め、 同じ投稿の再送は同じゴールを返す (CC-DG-INV-02)。
   * 登録した時点で見守り中にする。 セッションは起動しない (CC-DG-INV-01)。
   */
  registerGoal(input: RegisterGoalInput): { goal: DailyGoal; created: boolean } {
    const id = createHash("sha256").update(`${input.actor.platform}:${input.actor.guildId}:post:${input.sourceMessageId}`).digest("hex").slice(0, 24);
    const { goal, created } = this.deps.repo.create({
      id, date: input.businessDate, ...input.goal, sourceMessageId: input.sourceMessageId,
      confirmedBy: {
        platform: "discord", userId: input.actor.userId, guildId: input.actor.guildId, channelId: input.actor.channelId,
        messageId: input.sourceMessageId,
      },
      confirmedAt: input.now, createdAt: input.now,
    });
    if (created) this.touch(goal.id, `<@${input.actor.userId}> の投稿でゴールを登録しました。1 時間ごとに進み具合を確認します`);
    return { goal, created };
  }

  /** scheduler の 1 tick。 締切・確認・通知の順に進める。 */
  async tick(now: number): Promise<void> {
    await this.closer.closeDue(now);
    await this.checkpointer.runDue(now);
    this.reminder.notifyIfDue(now);
  }

  runCheckpoint(goalId: string, now: number): Promise<CheckpointOutcome> { return this.checkpointer.run(goalId, now); }
  stopByHuman(goalId: string, actor: GoalActor, now: number): DailyGoal { return this.finisher.stopByHuman(goalId, actor, now); }
  resendSummary(date: string, actor: GoalActor, now: number): Promise<DailyGoalDay> { return this.closer.resend(date, actor, now); }

  list(date?: string): DailyGoal[] { return this.deps.repo.list(date ? { date } : {}); }
  detail(goalId: string): DailyGoalDetail | null {
    const goal = this.deps.repo.byId(goalId);
    if (!goal) return null;
    return {
      goal, checkpoints: this.deps.repo.checkpoints(goalId), timeline: this.deps.repo.timeline(goalId),
      card: this.deps.repo.card(goalCardId(goalId)), alerts: this.deps.alerts.byGoal(goalId),
    };
  }
  dayDetail(date: string): DailyGoalDayDetail {
    return { day: this.deps.days.get(date), goals: this.deps.repo.onDate(date), drafts: this.deps.drafts.onDate(date) };
  }

  /** 配達側が描画するカードの中身。 撤廃した候補カードなど知らない種類は null (配達しない)。 */
  cardContent(card: DailyGoalCard, now: number): DailyGoalCardContent {
    if (card.kind === "reminder") return { kind: "reminder", date: card.refId, view: buildReminderView(card.refId) };
    if (card.kind === "summary") {
      const day = this.deps.days.get(card.refId);
      return day ? { kind: "summary", date: card.refId, view: buildDaySummaryCard(day, this.deps.repo.onDate(card.refId)) } : null;
    }
    if (card.kind !== "goal") return null;
    const goal = this.deps.repo.byId(card.refId);
    if (!goal) return null;
    return { kind: "goal", goalId: goal.id, view: buildGoalCard({
      goal, checkpoints: this.deps.repo.checkpoints(goal.id), timeline: this.deps.repo.timeline(goal.id), now,
      dayBoundary: this.deps.config().dayBoundary,
    }) };
  }

  /** 不調の通知の配達先と本文。 ゴールが消えていれば null (配達しない)。 */
  alertContent(alert: DailyGoalAlert): DailyGoalAlertContent | null {
    const goal = this.deps.repo.byId(alert.goalId);
    if (!goal) return null;
    const draft = goal.sourceMessageId ? this.deps.drafts.bySourceMessage(goal.sourceMessageId) : null;
    return {
      text: alert.text, mentionUserId: alert.mentionUserId,
      threadId: draft?.threadId ?? null, cardMessageId: this.deps.repo.card(goalCardId(goal.id))?.messageId ?? null,
    };
  }

  /** カードの配達を記録する。 通知・まとめの投稿は業務日の状態にも反映する。 */
  cardDelivered(cardId: string, revision: number, channelId: string, messageId: string, now: number): void {
    this.deps.repo.saveCard(cardId, revision, channelId, messageId);
    const card = this.deps.repo.card(cardId);
    if (card?.kind === "reminder") this.deps.days.reminderPosted(card.refId, messageId, now);
    if (card?.kind === "summary") this.deps.days.advanceClose(card.refId, "journaled", "posted", now);
  }
}
