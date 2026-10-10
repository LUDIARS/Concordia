/**
 * 締切 (翌朝の業務日境界) の use case: 締切停止 → 日のまとめ → Memoria への記載 → チャンネル投稿。
 *
 * @implements spec/feature/daily-goal-run.md — 8. 4:00 の締切と日のまとめ / CC-DG-INV-05 / CC-DG-INV-08 / CC-DG-INV-10 / CC-INV-03
 *
 * 各段の intent を daily_goal_days に先に保存してから副作用を起こす。 記載の結果不明は照合
 * (日記は GET、 ノートは外部 ID で同じものが返る) してから再送する。 Memoria に届かなければ
 * 未記載 (unwritten) で残し、 次の試行時刻を過ぎた tick で再送する。 失敗で落ちない。
 */

import { capabilityAllowed } from "../staff/roles.js";
import { isPastDeadline, goalsPastDeadline } from "./deadline-policy.js";
import { buildDaySummary, type SummaryGoalInput } from "./day-summary.js";
import { DAILY_GOAL_JOURNAL_SOURCE, dailyGoalNoteExternalId, type JournalCallResult } from "./memoria-journal.js";
import { DailyGoalConflict, type DailyGoal, type DailyGoalDay, type GoalActor } from "./domain.js";
import type { DailyGoalServiceDeps } from "./ports.js";
import type { JournalTarget } from "./day-repository.js";

/** 未記載・結果不明の再送までの待ち (Memoria が止まっている間に毎分叩かない)。 */
export const JOURNAL_RETRY_MS = 5 * 60_000;

export function summaryCardId(date: string): string { return `summary-${date}`; }

export interface DayCloseFinisher {
  stopByDeadline(goalId: string, now: number): Promise<DailyGoal | null>;
}

const SETTLED = new Set(["written", "unwritten", "unknown", "skipped"]);

export class DailyGoalDayCloser {
  constructor(
    private readonly deps: DailyGoalServiceDeps,
    private readonly finisher: DayCloseFinisher,
    private readonly touchSummaryCard: (date: string) => void,
  ) {}

  /** 締切を過ぎた業務日を 1 段ずつ進める。 */
  async closeDue(now: number): Promise<void> {
    for (const goal of this.deps.repo.listByStatus(["confirmed", "running"])) this.deps.days.ensure(goal.date, now);
    for (const date of this.deps.drafts.openDates()) this.deps.days.ensure(date, now);
    for (const day of this.deps.days.unfinished()) {
      try { await this.advance(day.businessDate, now); }
      catch (error) { this.deps.log?.warn(`daily goal day close failed date=${day.businessDate}: ${String(error)}`); }
    }
  }

  private async advance(date: string, now: number): Promise<void> {
    const { dayBoundary } = this.deps.config();
    if (!isPastDeadline(date, now, dayBoundary)) return;
    if (this.day(date).closeState === "none") this.deps.days.advanceClose(date, "none", "stopping", now);
    if (this.day(date).closeState === "stopping") {
      for (const goal of goalsPastDeadline(this.deps.repo.onDate(date), now, dayBoundary)) await this.finisher.stopByDeadline(goal.id, now);
      this.deps.drafts.expireOn(date, now);
      this.deps.days.saveSummary(date, buildDaySummary(this.summaryInput(date)), now);
    }
    const day = this.day(date);
    if (day.closeState === "summarized" || day.closeState === "journaled" || day.closeState === "posted") await this.journal(day, now);
    const after = this.day(date);
    if (after.closeState === "summarized" && SETTLED.has(after.diaryState) && SETTLED.has(after.noteState)) {
      // 記載を 1 回試したら投稿する。 未記載は投稿のカードに出し、 再送は続ける。
      if (this.deps.days.advanceClose(date, "summarized", "journaled", now)) this.touchSummaryCard(date);
    }
  }

  /** 人間の手動再送 (まとめ投稿の再送ボタン)。 本人確認と session_control が要る。 */
  async resend(date: string, actor: GoalActor, now: number): Promise<DailyGoalDay> {
    if (actor.isBot || actor.isWebhook || !actor.userId || !capabilityAllowed(actor.role, "session_control")) {
      throw new DailyGoalConflict("まとめの再送は管理職以上の本人操作でだけ行えます。", "forbidden");
    }
    if (!this.deps.days.resetJournal(date, now)) throw new DailyGoalConflict(`${date} のまとめはまだ記載の段に達していません。`, "not_ready");
    await this.journal(this.day(date), now);
    this.touchSummaryCard(date);
    return this.day(date);
  }

  private day(date: string): DailyGoalDay {
    return this.deps.days.get(date) ?? this.deps.days.ensure(date, Date.now());
  }

  private summaryInput(date: string) {
    const day = this.day(date);
    const goals: SummaryGoalInput[] = this.deps.repo.onDate(date).map((goal) => {
      const checkpoints = this.deps.repo.checkpoints(goal.id);
      const lastEvidence = [...checkpoints].reverse().find((cp) => cp.kind !== "skipped_waiting");
      const lastReport = [...checkpoints].reverse().find((cp) => cp.report)?.report ?? null;
      return { goal, evidence: lastEvidence?.evidence.items ?? [], lastReport };
    });
    return { date, goals, drafts: this.deps.drafts.onDate(date, ["open", "expired"]), noGoal: day.noGoalAt !== undefined };
  }

  /** 日記の節とノートを記載する。 結果不明は照合してから再送する。 */
  private async journal(day: DailyGoalDay, now: number): Promise<void> {
    if (!day.summaryMarkdown || !day.summaryTitle || day.nextAttemptAt > now) return;
    let changed = false;
    for (const target of ["diary", "note"] as const) {
      const state = target === "diary" ? day.diaryState : day.noteState;
      if (state === "written" || state === "skipped") continue;
      if (target === "diary" && (state === "intent" || state === "unknown")) {
        const check = await this.deps.journal.getDiarySection(day.businessDate, DAILY_GOAL_JOURNAL_SOURCE);
        if (!check.ok) { this.failed(day.businessDate, target, check, now); changed = true; continue; }
        if (check.value.exists) {
          this.deps.days.journalWritten(day.businessDate, target, { ...(check.value.url ? { url: check.value.url } : {}) }, now);
          changed = true;
          continue;
        }
      }
      if (!this.deps.days.claimJournal(day.businessDate, target, now)) continue;
      const body = { title: day.summaryTitle, markdown: day.summaryMarkdown };
      if (target === "diary") {
        const result = await this.deps.journal.putDiarySection(day.businessDate, DAILY_GOAL_JOURNAL_SOURCE, body);
        if (result.ok) this.deps.days.journalWritten(day.businessDate, target, { ...(result.value.url ? { url: result.value.url } : {}) }, now);
        else this.failed(day.businessDate, target, result, now);
      } else {
        const result = await this.deps.journal.createNote({ external_id: dailyGoalNoteExternalId(day.businessDate), source: DAILY_GOAL_JOURNAL_SOURCE, ...body });
        if (result.ok) this.deps.days.journalWritten(day.businessDate, target, { noteId: result.value.id, ...(result.value.url ? { url: result.value.url } : {}) }, now);
        else this.failed(day.businessDate, target, result, now);
      }
      changed = true;
    }
    const current = this.day(day.businessDate);
    if (changed && (current.closeState === "journaled" || current.closeState === "posted")) this.touchSummaryCard(day.businessDate);
  }

  private failed(date: string, target: JournalTarget, result: Extract<JournalCallResult<unknown>, { ok: false }>, now: number): void {
    this.deps.days.journalFailed(date, target, result.kind === "unknown" ? "unknown" : "unwritten", result.error, now + JOURNAL_RETRY_MS, now);
    this.deps.log?.warn(`daily goal ${target} not written date=${date}: ${result.error}`);
  }
}
