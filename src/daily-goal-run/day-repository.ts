/**
 * 業務日ごとの状態 (目標なし・9:00 の通知・4:00 のまとめと Memoria への記載) の永続化。
 *
 * @implements spec/feature/daily-goal-run.md — 7. 9:00 の通知 / 8. 4:00 の締切と日のまとめ / CC-DG-INV-10 / CC-DG-INV-11 / CC-INV-03
 *
 * 各段の intent を先に保存してから外部副作用を起こす。 状態遷移は CAS (WHERE 句) で守る。
 */

import type { Database } from "better-sqlite3";
import type { CloseState, DailyGoalDay, JournalState, ReminderState } from "./domain.js";

interface DayRow {
  business_date: string; no_goal_by: string | null; no_goal_at: number | null; reminder_state: ReminderState; reminder_message_id: string | null;
  summary_title: string | null; summary_markdown: string | null; close_state: CloseState; diary_state: JournalState; note_state: JournalState;
  diary_url: string | null; note_id: string | null; note_url: string | null; error: string | null; next_attempt_at: number; updated_at: number;
}

export type JournalTarget = "diary" | "note";

const COLUMN: Record<JournalTarget, "diary_state" | "note_state"> = { diary: "diary_state", note: "note_state" };

export class DailyGoalDayRepository {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS daily_goal_days (
      business_date TEXT PRIMARY KEY, no_goal_by TEXT, no_goal_at INTEGER, reminder_state TEXT NOT NULL DEFAULT 'none',
      reminder_message_id TEXT, summary_title TEXT, summary_markdown TEXT, close_state TEXT NOT NULL DEFAULT 'none',
      diary_state TEXT NOT NULL DEFAULT 'none', note_state TEXT NOT NULL DEFAULT 'none', diary_url TEXT, note_id TEXT, note_url TEXT,
      error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );`);
  }

  private decode(raw: unknown): DailyGoalDay | null {
    if (!raw) return null;
    const r = raw as DayRow;
    return {
      businessDate: r.business_date, reminderState: r.reminder_state, closeState: r.close_state, diaryState: r.diary_state,
      noteState: r.note_state, nextAttemptAt: r.next_attempt_at, updatedAt: r.updated_at,
      ...(r.no_goal_by ? { noGoalBy: r.no_goal_by } : {}),
      ...(r.no_goal_at !== null ? { noGoalAt: r.no_goal_at } : {}),
      ...(r.reminder_message_id ? { reminderMessageId: r.reminder_message_id } : {}),
      ...(r.summary_title ? { summaryTitle: r.summary_title } : {}),
      ...(r.summary_markdown ? { summaryMarkdown: r.summary_markdown } : {}),
      ...(r.diary_url ? { diaryUrl: r.diary_url } : {}),
      ...(r.note_id ? { noteId: r.note_id } : {}),
      ...(r.note_url ? { noteUrl: r.note_url } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  ensure(date: string, now: number): DailyGoalDay {
    this.db.prepare("INSERT OR IGNORE INTO daily_goal_days (business_date, updated_at) VALUES (?, ?)").run(date, now);
    return this.get(date)!;
  }
  get(date: string): DailyGoalDay | null {
    return this.decode(this.db.prepare("SELECT * FROM daily_goal_days WHERE business_date=?").get(date));
  }
  /** まとめが終わっていない日、 または記載が未完了の日。 */
  unfinished(): DailyGoalDay[] {
    return this.db.prepare(`SELECT * FROM daily_goal_days WHERE close_state NOT IN ('posted','skipped')
      OR diary_state IN ('intent','unknown','unwritten') OR note_state IN ('intent','unknown','unwritten') ORDER BY business_date LIMIT 60`)
      .all().map((r) => this.decode(r)!);
  }

  /** 目標なしを記録する。 既に記録済みなら false。 */
  recordNoGoal(date: string, userId: string, now: number): boolean {
    this.ensure(date, now);
    return this.db.prepare("UPDATE daily_goal_days SET no_goal_by=?, no_goal_at=?, updated_at=? WHERE business_date=? AND no_goal_at IS NULL")
      .run(userId, now, now, date).changes === 1;
  }

  /** 通知の intent。 未通知の日だけが 1 回だけ通る。 */
  claimReminder(date: string, now: number): boolean {
    this.ensure(date, now);
    return this.db.prepare("UPDATE daily_goal_days SET reminder_state='queued', updated_at=? WHERE business_date=? AND reminder_state='none'")
      .run(now, date).changes === 1;
  }
  reminderPosted(date: string, messageId: string, now: number): void {
    this.db.prepare("UPDATE daily_goal_days SET reminder_state='posted', reminder_message_id=?, updated_at=? WHERE business_date=?").run(messageId, now, date);
  }

  /** まとめの段の CAS。 */
  advanceClose(date: string, from: CloseState, to: CloseState, now: number): boolean {
    return this.db.prepare("UPDATE daily_goal_days SET close_state=?, updated_at=? WHERE business_date=? AND close_state=?").run(to, now, date, from).changes === 1;
  }
  /** まとめを保存して summarized へ。 記載しない日は skipped (記載も skipped)。 */
  saveSummary(date: string, summary: { title: string; markdown: string } | null, now: number): boolean {
    if (!summary) {
      return this.db.prepare(`UPDATE daily_goal_days SET close_state='skipped', diary_state='skipped', note_state='skipped', updated_at=?
        WHERE business_date=? AND close_state='stopping'`).run(now, date).changes === 1;
    }
    return this.db.prepare(`UPDATE daily_goal_days SET close_state='summarized', summary_title=?, summary_markdown=?, updated_at=?
      WHERE business_date=? AND close_state='stopping'`).run(summary.title, summary.markdown, now, date).changes === 1;
  }

  /** 記載の intent。 none / unwritten / unknown / intent (前回の結果不明) から intent へ。 */
  claimJournal(date: string, target: JournalTarget, now: number): boolean {
    const column = COLUMN[target];
    return this.db.prepare(`UPDATE daily_goal_days SET ${column}='intent', updated_at=? WHERE business_date=? AND ${column} IN ('none','unwritten','unknown','intent')`)
      .run(now, date).changes === 1;
  }
  journalWritten(date: string, target: JournalTarget, input: { url?: string; noteId?: string }, now: number): void {
    if (target === "diary") {
      this.db.prepare("UPDATE daily_goal_days SET diary_state='written', diary_url=COALESCE(?, diary_url), updated_at=? WHERE business_date=?")
        .run(input.url ?? null, now, date);
      return;
    }
    this.db.prepare("UPDATE daily_goal_days SET note_state='written', note_id=COALESCE(?, note_id), note_url=COALESCE(?, note_url), updated_at=? WHERE business_date=?")
      .run(input.noteId ?? null, input.url ?? null, now, date);
  }
  /** 届かなかった (unwritten) / 結果不明 (unknown)。 次の試行時刻を置く。 */
  journalFailed(date: string, target: JournalTarget, state: "unwritten" | "unknown", error: string, nextAttemptAt: number, now: number): void {
    this.db.prepare(`UPDATE daily_goal_days SET ${COLUMN[target]}=?, error=?, next_attempt_at=?, updated_at=? WHERE business_date=?`)
      .run(state, error.slice(0, 2000), nextAttemptAt, now, date);
  }
  /** 人間の再送: 記載済みも含めて記載をやり直す (日記の節は置き換え、 ノートは外部 ID で 1 本)。 */
  resetJournal(date: string, now: number): boolean {
    return this.db.prepare(`UPDATE daily_goal_days SET diary_state='none', note_state='none', next_attempt_at=0, error=NULL, updated_at=?
      WHERE business_date=? AND close_state IN ('journaled','posted')`).run(now, date).changes === 1;
  }
}
