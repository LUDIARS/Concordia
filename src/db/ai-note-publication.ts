import type Database from "better-sqlite3";
import { destinationKey, type Article, type Destination, type Publication, type PublicationStore, type Receipt, type SendResult } from "../ai-notes/model.js";

interface Row extends Omit<Publication, "article" | "target" | "receipt"> { article_json: string; target_json: string; receipt_json: string | null; }
function decode(row: Row): Publication {
  const { article_json, target_json, receipt_json, ...rest } = row;
  return { ...rest, article: JSON.parse(article_json) as Article, target: JSON.parse(target_json) as Destination,
    receipt: receipt_json ? JSON.parse(receipt_json) as Receipt : null };
}

export class SqlitePublicationStore implements PublicationStore {
  constructor(private readonly db: Database.Database) {}
  targets(): Destination[] {
    return (this.db.prepare("SELECT target_json FROM ai_note_targets ORDER BY target_key").all() as Array<{ target_json: string }>)
      .map(row => JSON.parse(row.target_json) as Destination);
  }
  replaceTargets(targets: Destination[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ai_note_targets").run();
      const insert = this.db.prepare("INSERT INTO ai_note_targets(target_key, target_json) VALUES (?, ?)");
      for (const target of targets) insert.run(destinationKey(target), JSON.stringify(target));
    }).immediate();
  }
  enqueue(article: Article, targets: Destination[], now: number): void {
    this.db.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO ai_note_publications(article_id, target_key, article_json, target_json, status, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT(article_id, target_key) DO NOTHING`);
      for (const target of targets) insert.run(article.page_id, destinationKey(target), JSON.stringify(article), JSON.stringify(target), now);
    }).immediate();
  }
  list(articleId: string): Publication[] {
    return (this.db.prepare("SELECT * FROM ai_note_publications WHERE article_id = ? ORDER BY target_key").all(articleId) as Row[]).map(decode);
  }
  find(articleId: string, targetKey: string): Publication | null {
    const row = this.db.prepare("SELECT * FROM ai_note_publications WHERE article_id = ? AND target_key = ?").get(articleId, targetKey) as Row | undefined;
    return row ? decode(row) : null;
  }
  expireSending(before: number, now: number): void {
    this.db.prepare(`UPDATE ai_note_publications SET status = 'unknown', error_code = 'interrupted_delivery', updated_at = ?
      WHERE status = 'sending' AND updated_at < ?`).run(now, before);
  }
  claim(articleId: string, targetKey: string, from: "pending" | "failed", attemptId: string, now: number): boolean {
    return this.db.prepare(`UPDATE ai_note_publications SET status = 'sending', attempt_id = ?, error_code = NULL, updated_at = ?
      WHERE article_id = ? AND target_key = ? AND status = ?`).run(attemptId, now, articleId, targetKey, from).changes === 1;
  }
  finish(articleId: string, targetKey: string, attemptId: string, result: SendResult, now: number): void {
    this.db.prepare(`UPDATE ai_note_publications SET status = ?, receipt_json = ?, error_code = ?, updated_at = ?
      WHERE article_id = ? AND target_key = ? AND attempt_id = ? AND status = 'sending'`).run(
      result.status, result.status === "sent" ? JSON.stringify(result.receipt) : null,
      result.status === "sent" ? null : result.error_code, now, articleId, targetKey, attemptId);
  }
  reconcile(row: Publication, receipt: Receipt, now: number): boolean {
    return this.db.prepare(`UPDATE ai_note_publications SET status = 'sent', receipt_json = ?, error_code = NULL,
      resolution = 'verified_remote_message', updated_at = ? WHERE article_id = ? AND target_key = ? AND status = 'unknown' AND attempt_id IS ?`)
      .run(JSON.stringify(receipt), now, row.article_id, row.target_key, row.attempt_id).changes === 1;
  }
  confirmAbsent(row: Publication, reason: string, now: number): boolean {
    return this.db.prepare(`UPDATE ai_note_publications SET status = 'failed', error_code = 'human_confirmed_absent', resolution = ?, updated_at = ?
      WHERE article_id = ? AND target_key = ? AND status = 'unknown' AND attempt_id IS ?`)
      .run(reason, now, row.article_id, row.target_key, row.attempt_id).changes === 1;
  }
}
