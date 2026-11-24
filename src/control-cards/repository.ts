/**
 * control_cards / control_card_reminders の保存 (adapter)。
 *
 * @implements spec/feature/control-cards.md — 状態の所有者 control_cards
 */
import type Database from "better-sqlite3";
import {
  CARD_KIND_OF,
  DEFAULT_REMIND_AFTER_MS,
  type CardSourceItem,
  type CardState,
  type CardTriagePatch,
  type ControlCard,
} from "./card-domain.js";

export interface ReminderRecord {
  id: number;
  card_id: string;
  sent_at: number;
  channel: string;
  text: string;
}

export class ControlCardsRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  find(id: string): ControlCard | null {
    return (this.db.prepare("SELECT * FROM control_cards WHERE id = ?").get(id) as ControlCard | undefined) ?? null;
  }

  findBySource(kind: string, key: string): ControlCard | null {
    return (this.db.prepare("SELECT * FROM control_cards WHERE source_kind = ? AND source_key = ?").get(kind, key) as ControlCard | undefined) ?? null;
  }

  listOpen(): ControlCard[] {
    return this.db.prepare("SELECT * FROM control_cards WHERE state = 'open' ORDER BY raised_at ASC, id ASC").all() as ControlCard[];
  }

  /** 一覧。state 省略で開閉とも、閉じたものは新しい順に limit 件まで。 */
  list(state: CardState | null, limit: number): ControlCard[] {
    if (state === "open") return this.listOpen();
    if (state === "closed") {
      return this.db.prepare("SELECT * FROM control_cards WHERE state = 'closed' ORDER BY closed_at DESC LIMIT ?").all(limit) as ControlCard[];
    }
    return [...this.listOpen(), ...this.list("closed", limit)];
  }

  listBySession(sessionId: string): ControlCard[] {
    return this.db.prepare("SELECT * FROM control_cards WHERE session_id = ? ORDER BY raised_at ASC").all(sessionId) as ControlCard[];
  }

  /**
   * 出所の 1 件からカードを作る。同じ出所のカードが閉じていれば開き直す (出所が再び未解決になった)。
   * 既定の捌き: 優先度 normal、催促は 24 時間後 (§3)。
   */
  open(id: string, item: CardSourceItem, now: number): ControlCard {
    const existing = this.findBySource(item.source_kind, item.source_key);
    if (existing) {
      if (existing.state === "open") return existing;
      this.db.prepare(`UPDATE control_cards SET state = 'open', summary = ?, link = ?, closed_at = NULL, close_reason = NULL,
        remind_at = ?, updated_at = ? WHERE id = ?`).run(item.summary, item.link, now + DEFAULT_REMIND_AFTER_MS, now, existing.id);
      return this.find(existing.id)!;
    }
    this.db.prepare(`INSERT INTO control_cards (id, source_kind, source_key, card_kind, summary, session_id, project, link, state,
        raised_at, priority, remind_at, created_at, updated_at)
      VALUES (@id, @source_kind, @source_key, @card_kind, @summary, @session_id, @project, @link, 'open',
        @raised_at, 'normal', @remind_at, @now, @now)`).run({
      id, ...item, card_kind: CARD_KIND_OF[item.source_kind], remind_at: now + DEFAULT_REMIND_AFTER_MS, now,
    });
    return this.find(id)!;
  }

  refresh(id: string, summary: string, link: string | null, now: number): void {
    this.db.prepare("UPDATE control_cards SET summary = ?, link = ?, updated_at = ? WHERE id = ? AND state = 'open'").run(summary, link, now, id);
  }

  /** 開いているときだけ閉じる。閉じたら true。 */
  close(id: string, reason: string, now: number): boolean {
    return this.db.prepare("UPDATE control_cards SET state = 'closed', closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ? AND state = 'open'")
      .run(now, reason, now, id).changes === 1;
  }

  /** 捌きの列だけを書く (CC-V5-INV-04)。開いているカードにだけ効く。 */
  triage(id: string, patch: CardTriagePatch, triagedBy: string, now: number): ControlCard | null {
    const current = this.find(id);
    if (!current || current.state !== "open") return null;
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE control_cards SET priority = @priority, assignee = @assignee, remind_at = @remind_at,
        reminder_text = @reminder_text, card_group = @card_group, triaged_by = @triaged_by, triaged_at = @now, updated_at = @now
      WHERE id = @id AND state = 'open'`).run({
      id, priority: next.priority, assignee: next.assignee, remind_at: next.remind_at, reminder_text: next.reminder_text,
      card_group: next.card_group, triaged_by: triagedBy, now,
    });
    return this.find(id);
  }

  /** 催促の予定だけを動かす (催促の送信後)。捌きの出所は変えない。 */
  reschedule(id: string, remindAt: number, now: number): void {
    this.db.prepare("UPDATE control_cards SET remind_at = ?, updated_at = ? WHERE id = ? AND state = 'open'").run(remindAt, now, id);
  }

  lastReminderAt(cardId: string): number | null {
    const row = this.db.prepare("SELECT MAX(sent_at) AS at FROM control_card_reminders WHERE card_id = ?").get(cardId) as { at: number | null };
    return row.at ?? null;
  }

  recordReminder(cardId: string, sentAt: number, channel: string, text: string): void {
    this.db.prepare("INSERT INTO control_card_reminders (card_id, sent_at, channel, text) VALUES (?, ?, ?, ?)").run(cardId, sentAt, channel, text);
  }

  reminders(cardId: string, limit = 20): ReminderRecord[] {
    return this.db.prepare("SELECT * FROM control_card_reminders WHERE card_id = ? ORDER BY sent_at DESC LIMIT ?").all(cardId, limit) as ReminderRecord[];
  }
}
