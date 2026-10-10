/**
 * デイリーゴール自走の application service (use case の窓口)。
 *
 * @implements spec/feature/daily-goal-run.md — 流れ 1〜8 / CC-DG-INV-01〜11
 *
 * 登録 (registerGoal) はここ、 投稿の読み取り・起動・確認・終了・締切・通知は専用モジュールへ委ねる。
 * 認可と副作用の順序を明示し、 外部 I/O は port 経由で行う。
 */

import { createHash } from "node:crypto";
import { DailyGoalLauncher } from "./launch.js";
import { DailyGoalCheckpointer } from "./checkpoint.js";
import { DailyGoalFinisher, type EvidenceClaim, type ExhaustedOutcome, type ReachedOutcome } from "./finish.js";
import { DailyGoalPostIntake, type RegisterGoalInput } from "./post-intake.js";
import { DailyGoalDayCloser, summaryCardId } from "./day-close.js";
import { DailyGoalReminder, reminderCardId } from "./reminder.js";
import { buildDaySummaryCard, buildGoalCard, buildReminderView, type DailyGoalCardView, type DaySummaryCardView } from "./card.js";
import { DailyGoalConflict } from "./domain.js";
import type { DailyGoal, DailyGoalCheckpoint, DailyGoalDay, DailyGoalDraft, GoalActor, RemainingItem } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";
import type { DailyGoalCard, TimelineEntry } from "./repository.js";

export interface DailyGoalDetail {
  goal: DailyGoal;
  checkpoints: DailyGoalCheckpoint[];
  timeline: TimelineEntry[];
  card: DailyGoalCard | null;
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

export function goalCardId(goalId: string): string { return `goal-${goalId}`; }

export class DailyGoalRunService {
  readonly intake: DailyGoalPostIntake;
  private readonly launcher: DailyGoalLauncher;
  private readonly checkpointer: DailyGoalCheckpointer;
  private readonly finisher: DailyGoalFinisher;
  private readonly closer: DailyGoalDayCloser;
  private readonly reminder: DailyGoalReminder;

  constructor(readonly deps: DailyGoalServiceDeps) {
    const touch = (goalId: string, line?: string): void => this.touch(goalId, line);
    this.launcher = new DailyGoalLauncher(deps, touch);
    this.finisher = new DailyGoalFinisher(deps, touch);
    this.checkpointer = new DailyGoalCheckpointer(deps, touch, (sessionId, now) => this.finisher.onSessionLost(sessionId, now));
    this.closer = new DailyGoalDayCloser(deps, this.finisher, (date) => deps.repo.touchCard(summaryCardId(date), "summary", date));
    this.reminder = new DailyGoalReminder(deps, (date) => deps.repo.touchCard(reminderCardId(date), "reminder", date));
    this.intake = new DailyGoalPostIntake(deps, (input) => this.registerGoal(input), (now) => this.launchSoon(now));
  }

  /** カードの版を上げ、 必要ならタイムラインに 1 行足す。 */
  private touch(goalId: string, line?: string): void {
    if (line) this.deps.repo.addTimeline(goalId, Date.now(), line);
    this.deps.repo.touchCard(goalCardId(goalId), "goal", goalId);
  }

  /**
   * 投稿から読み取りがそろったゴールの登録。 認可と許可の上限は post-intake が済ませている。
   * id は投稿 (message id) から決め、 同じ投稿の再送は同じゴールを返す (CC-DG-INV-02)。
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
    if (created) this.touch(goal.id, `<@${input.actor.userId}> の投稿でゴールを登録しました`);
    return { goal, created };
  }

  /** 登録の直後に起動を試みる (scheduler の次 tick を待たない)。 */
  launchSoon(now: number = Date.now()): void {
    void this.launcher.launchDue(now).catch((error) => this.deps.log?.warn(`daily goal immediate launch failed: ${String(error)}`));
  }

  /** scheduler の 1 tick。 締切・起動・照合・確認・通知の順に進める。 */
  async tick(now: number): Promise<void> {
    this.launcher.reconcile(now);
    await this.closer.closeDue(now);
    await this.launcher.launchDue(now);
    this.launcher.reconcile(now);
    await this.checkpointer.runDue(now);
    this.reminder.notifyIfDue(now);
  }

  launchDue(now: number): Promise<void> { return this.launcher.launchDue(now); }
  runCheckpoint(goalId: string, now: number) { return this.checkpointer.run(goalId, now); }
  reportReached(goalId: string, sessionId: string, claims: readonly EvidenceClaim[], now: number): Promise<ReachedOutcome> {
    return this.finisher.reportReached(goalId, sessionId, claims, now);
  }
  reportExhausted(goalId: string, sessionId: string, remaining: readonly RemainingItem[], now: number): ExhaustedOutcome {
    return this.finisher.reportExhausted(goalId, sessionId, remaining, now);
  }
  stopByHuman(goalId: string, actor: GoalActor, now: number): DailyGoal { return this.finisher.stopByHuman(goalId, actor, now); }
  onSessionLost(sessionId: string, now: number): void { this.finisher.onSessionLost(sessionId, now); }
  resendSummary(date: string, actor: GoalActor, now: number): Promise<DailyGoalDay> { return this.closer.resend(date, actor, now); }

  list(date?: string): DailyGoal[] { return this.deps.repo.list(date ? { date } : {}); }
  detail(goalId: string): DailyGoalDetail | null {
    const goal = this.deps.repo.byId(goalId);
    if (!goal) return null;
    return { goal, checkpoints: this.deps.repo.checkpoints(goalId), timeline: this.deps.repo.timeline(goalId), card: this.deps.repo.card(goalCardId(goalId)) };
  }
  dayDetail(date: string): DailyGoalDayDetail {
    return { day: this.deps.days.get(date), goals: this.deps.repo.onDate(date), drafts: this.deps.drafts.onDate(date) };
  }

  /**
   * セッションの報告 (進み具合・次の 1 時間・判断点) を直近の確認へ記録する。
   * 自己申告であり、 進捗・到達の判定には使わない (CC-DG-INV-03)。
   */
  recordReport(goalId: string, sessionId: string, text: string): void {
    const goal = this.deps.repo.byId(goalId);
    if (!goal || goal.sessionId !== sessionId) throw new DailyGoalConflict("このゴールに紐付いた専用セッションではありません。", "forbidden");
    const last = this.deps.repo.lastCheckpoint(goalId, ["progress", "completion"]);
    if (!last) throw new DailyGoalConflict("報告できる確認がまだありません。", "no_checkpoint");
    this.deps.repo.setCheckpointReport(last.id, text.trim().slice(0, 2000));
    this.touch(goalId);
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
    const waiting = goal.status === "running" && !!goal.sessionId && this.deps.waiting.isWaiting(goal.sessionId);
    return { kind: "goal", goalId: goal.id, view: buildGoalCard({
      goal, checkpoints: this.deps.repo.checkpoints(goal.id), timeline: this.deps.repo.timeline(goal.id), waiting, now,
      dayBoundary: this.deps.config().dayBoundary,
    }) };
  }

  /** カードの配達を記録する。 通知・まとめの投稿は業務日の状態にも反映する。 */
  cardDelivered(cardId: string, revision: number, channelId: string, messageId: string, now: number): void {
    this.deps.repo.saveCard(cardId, revision, channelId, messageId);
    const card = this.deps.repo.card(cardId);
    if (card?.kind === "reminder") this.deps.days.reminderPosted(card.refId, messageId, now);
    if (card?.kind === "summary") this.deps.days.advanceClose(card.refId, "journaled", "posted", now);
  }
}
