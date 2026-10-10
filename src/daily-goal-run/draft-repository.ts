/**
 * デイリーゴールの下書き (投稿から読み取ったが登録に足りないもの) の永続化。
 *
 * @implements spec/feature/daily-goal-run.md — 2. 下書きと聞き返し / CC-DG-INV-02
 *
 * 1 投稿 (source_message_id) に下書き 1 行。 登録したら registered にし、 同じ投稿から
 * 2 件目のゴールを作らない。 締切を過ぎた open の下書きは expired にする。
 */

import type { Database } from "better-sqlite3";
import type { DailyGoalDraft, DraftStatus, ExtractedGoal, PostField } from "./domain.js";

interface DraftRow {
  id: string; business_date: string; source_message_id: string; author_user_id: string; guild_id: string; channel_id: string;
  thread_id: string | null; text_parts: string; extracted: string | null; missing: string; status: DraftStatus; goal_id: string | null;
  created_at: number; updated_at: number;
}

export class DailyGoalDraftRepository {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS daily_goal_drafts (
      id TEXT PRIMARY KEY, business_date TEXT NOT NULL, source_message_id TEXT NOT NULL UNIQUE, author_user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, text_parts TEXT NOT NULL, extracted TEXT,
      missing TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', goal_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS daily_goal_drafts_date ON daily_goal_drafts(business_date, status);
    CREATE INDEX IF NOT EXISTS daily_goal_drafts_thread ON daily_goal_drafts(thread_id);`);
  }

  private decode(raw: unknown): DailyGoalDraft | null {
    if (!raw) return null;
    const r = raw as DraftRow;
    return {
      id: r.id, businessDate: r.business_date, sourceMessageId: r.source_message_id, authorUserId: r.author_user_id,
      guildId: r.guild_id, channelId: r.channel_id, textParts: JSON.parse(r.text_parts) as string[],
      extracted: r.extracted ? JSON.parse(r.extracted) as ExtractedGoal : null, missing: JSON.parse(r.missing) as PostField[],
      status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
      ...(r.thread_id ? { threadId: r.thread_id } : {}),
      ...(r.goal_id ? { goalId: r.goal_id } : {}),
    };
  }

  /** 投稿 1 件の下書きを作る。 同じ投稿の再配送は既存行を返す。 */
  create(input: Pick<DailyGoalDraft, "id" | "businessDate" | "sourceMessageId" | "authorUserId" | "guildId" | "channelId" | "textParts"> & { now: number }): { draft: DailyGoalDraft; created: boolean } {
    const info = this.db.prepare(`INSERT OR IGNORE INTO daily_goal_drafts (id,business_date,source_message_id,author_user_id,guild_id,channel_id,text_parts,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(input.id, input.businessDate, input.sourceMessageId, input.authorUserId, input.guildId, input.channelId,
      JSON.stringify(input.textParts), input.now, input.now);
    return { draft: this.bySourceMessage(input.sourceMessageId)!, created: info.changes === 1 };
  }

  byId(id: string): DailyGoalDraft | null { return this.decode(this.db.prepare("SELECT * FROM daily_goal_drafts WHERE id=?").get(id)); }
  bySourceMessage(messageId: string): DailyGoalDraft | null {
    return this.decode(this.db.prepare("SELECT * FROM daily_goal_drafts WHERE source_message_id=?").get(messageId));
  }
  byThread(threadId: string): DailyGoalDraft | null {
    return this.decode(this.db.prepare("SELECT * FROM daily_goal_drafts WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(threadId));
  }
  /** 業務日の下書き。 status を省くと全状態。 */
  onDate(businessDate: string, statuses?: readonly DraftStatus[]): DailyGoalDraft[] {
    const where = statuses?.length ? ` AND status IN (${statuses.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT * FROM daily_goal_drafts WHERE business_date=?${where} ORDER BY created_at`)
      .all(businessDate, ...(statuses ?? [])).map((r) => this.decode(r)!);
  }
  openDates(): string[] {
    return (this.db.prepare("SELECT DISTINCT business_date FROM daily_goal_drafts WHERE status='open'").all() as Array<{ business_date: string }>)
      .map((r) => r.business_date);
  }

  /** 読み直しの結果を保存する。 open の下書きだけ。 */
  saveReading(id: string, input: { textParts: string[]; extracted: ExtractedGoal | null; missing: PostField[]; now: number }): boolean {
    return this.db.prepare("UPDATE daily_goal_drafts SET text_parts=?, extracted=?, missing=?, updated_at=? WHERE id=? AND status='open'")
      .run(JSON.stringify(input.textParts), input.extracted ? JSON.stringify(input.extracted) : null, JSON.stringify(input.missing), input.now, id).changes === 1;
  }
  setThread(id: string, threadId: string, now: number): void {
    this.db.prepare("UPDATE daily_goal_drafts SET thread_id=COALESCE(thread_id, ?), updated_at=? WHERE id=?").run(threadId, now, id);
  }
  /** 登録の CAS。 open の下書きだけが 1 回だけ registered になる。 */
  markRegistered(id: string, goalId: string, now: number): boolean {
    return this.db.prepare("UPDATE daily_goal_drafts SET status='registered', goal_id=?, updated_at=? WHERE id=? AND status='open'")
      .run(goalId, now, id).changes === 1;
  }
  /** 締切を迎えた open の下書きを expired にする。 */
  expireOn(businessDate: string, now: number): number {
    return this.db.prepare("UPDATE daily_goal_drafts SET status='expired', updated_at=? WHERE business_date=? AND status='open'").run(now, businessDate).changes;
  }
}
