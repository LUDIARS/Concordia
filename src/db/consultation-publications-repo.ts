/**
 * 相談の公開候補 (consultation_publications) の repository。 保存と照会だけを持つ。
 * 公開の可否 (本人だけ) と Tabula への投稿は src/consultation/publication-service.ts。
 *
 * @implements SPEC-CONSULT-PUBLISH
 * @implements SPEC-CONSULT-TABULA
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ConsultationPublicationStatus = "proposed" | "published" | "declined" | "withdrawn";

export interface ConsultationPublicationRow {
  id: string;
  consultation_id: string;
  status: ConsultationPublicationStatus;
  title: string;
  summary: string;
  published_text: string | null;
  card_message_id: string | null;
  tabula_page_id: string | null;
  tabula_url: string | null;
  last_error: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
}

export class ConsultationPublicationsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: { consultation_id: string; title: string; summary: string }, now: number = Date.now()): ConsultationPublicationRow {
    const id = `cp_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO consultation_publications(id, consultation_id, status, title, summary, published_text, card_message_id,
        tabula_page_id, tabula_url, last_error, decided_by, decided_at, created_at, updated_at)
      VALUES (?, ?, 'proposed', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(id, input.consultation_id, input.title, input.summary, now, now);
    return this.find(id)!;
  }

  find(id: string): ConsultationPublicationRow | null {
    return (this.db.prepare("SELECT * FROM consultation_publications WHERE id = ?").get(id) as
      ConsultationPublicationRow | undefined) ?? null;
  }

  listForConsultation(consultationId: string): ConsultationPublicationRow[] {
    return this.db.prepare(
      "SELECT * FROM consultation_publications WHERE consultation_id = ? ORDER BY created_at DESC, id DESC",
    ).all(consultationId) as ConsultationPublicationRow[];
  }

  /** 公開済みの相談 (新しい順)。 重複した相談の近道の候補 (duplicate-consultation.ts)。 */
  listPublished(limit: number): ConsultationPublicationRow[] {
    return this.db.prepare(
      "SELECT * FROM consultation_publications WHERE status = 'published' ORDER BY decided_at DESC, id DESC LIMIT ?",
    ).all(limit) as ConsultationPublicationRow[];
  }

  setCardMessage(id: string, messageId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE consultation_publications SET card_message_id = ?, updated_at = ? WHERE id = ?")
      .run(messageId, now, id);
  }

  /** 公開済みにする。 proposed のときだけ (二重公開しない)。 */
  markPublished(id: string, input: {
    decided_by: string;
    published_text: string;
    tabula_page_id: string;
    tabula_url: string;
  }, now: number = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE consultation_publications
      SET status = 'published', decided_by = ?, decided_at = ?, published_text = ?, tabula_page_id = ?, tabula_url = ?,
        last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'proposed'
    `).run(input.decided_by, now, input.published_text, input.tabula_page_id, input.tabula_url, now, id).changes > 0;
  }

  /** 公開しない (本人) / 取り下げ (権限者)。 proposed のときだけ。 */
  markClosed(id: string, status: "declined" | "withdrawn", decidedBy: string, now: number = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE consultation_publications SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed'
    `).run(status, decidedBy, now, now, id).changes > 0;
  }

  /** 投稿の失敗を残す (proposed のまま再試行できる)。 */
  recordError(id: string, error: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE consultation_publications SET last_error = ?, updated_at = ? WHERE id = ?").run(error, now, id);
  }
}
