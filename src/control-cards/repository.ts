/**
 * control_cards / control_card_reminders の保存 (adapter)。
 *
 * @implements spec/feature/control-cards.md — 状態の所有者 control_cards
 */
import type Database from "better-sqlite3";
import {
  CARD_KIND_OF,
  DEFAULT_REMIND_AFTER_MS,
  type CardDiscardReason,
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

  /**
   * 一覧。state 省略で開閉とも (破棄は含めない)、閉じた・破棄したものは新しい順に limit 件まで。
   * 破棄したカードは state = discarded のときだけ返す (CC-V5-INV-08)。
   */
  list(state: CardState | null, limit: number): ControlCard[] {
    if (state === "open") return this.listOpen();
    if (state === "closed") {
      return this.db.prepare("SELECT * FROM control_cards WHERE state = 'closed' ORDER BY closed_at DESC LIMIT ?").all(limit) as ControlCard[];
    }
    if (state === "discarded") {
      return this.db.prepare("SELECT * FROM control_cards WHERE state = 'discarded' ORDER BY discarded_at DESC, id ASC LIMIT ?").all(limit) as ControlCard[];
    }
    return [...this.listOpen(), ...this.list("closed", limit)];
  }

  /** 破棄したカードの出所 (同期で作り直さないため、1 回の照会で引く)。 */
  discardedSources(): Array<{ source_kind: string; source_key: string }> {
    return this.db.prepare("SELECT source_kind, source_key FROM control_cards WHERE state = 'discarded'").all() as Array<{ source_kind: string; source_key: string }>;
  }

  countDiscarded(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM control_cards WHERE state = 'discarded'").get() as { n: number }).n;
  }

  /** セッション別のカード (依頼詳細)。破棄したものは出さない。 */
  listBySession(sessionId: string): ControlCard[] {
    return this.db.prepare("SELECT * FROM control_cards WHERE session_id = ? AND state != 'discarded' ORDER BY raised_at ASC").all(sessionId) as ControlCard[];
  }

  /**
   * 出所の 1 件からカードを作る。同じ出所のカードが閉じていれば開き直す (出所が再び未解決になった)。
   * 破棄したカードは開き直さない (CC-V5-INV-08)。既定の捌き: 優先度 normal、催促は 24 時間後 (§3)。
   */
  open(id: string, item: CardSourceItem, now: number): ControlCard {
    const existing = this.findBySource(item.source_kind, item.source_key);
    if (existing) {
      if (existing.state === "open" || existing.state === "discarded") return existing;
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

  /**
   * 持ち主が active でない出所を最初から破棄済みで残す (毎巡回作り直さないため)。閉じていたカードは破棄に移す。
   * 開いている・破棄済みのカードは変えない。
   */
  openDiscarded(id: string, item: CardSourceItem, reason: CardDiscardReason, now: number): ControlCard {
    const existing = this.findBySource(item.source_kind, item.source_key);
    if (existing) {
      if (existing.state === "closed") {
        this.db.prepare(`UPDATE control_cards SET state = 'discarded', discarded_at = ?, discard_reason = ?, remind_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'closed'`).run(now, reason, now, existing.id);
        return this.find(existing.id)!;
      }
      return existing;
    }
    this.db.prepare(`INSERT INTO control_cards (id, source_kind, source_key, card_kind, summary, session_id, project, link, state,
        raised_at, discarded_at, discard_reason, priority, created_at, updated_at)
      VALUES (@id, @source_kind, @source_key, @card_kind, @summary, @session_id, @project, @link, 'discarded',
        @raised_at, @now, @reason, 'normal', @now, @now)`).run({ id, ...item, card_kind: CARD_KIND_OF[item.source_kind], reason, now });
    return this.find(id)!;
  }

  /** 開いているときだけ破棄する。出所は書き換えない (CC-V5-INV-02)。破棄したら true。 */
  discard(id: string, reason: CardDiscardReason, now: number): boolean {
    return this.db.prepare(`UPDATE control_cards SET state = 'discarded', discarded_at = ?, discard_reason = ?, remind_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'open'`).run(now, reason, now, id).changes === 1;
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
