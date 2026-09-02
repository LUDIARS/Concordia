import type Database from "better-sqlite3";

/**
 * チャット channel:
 *  - chitchat:     雑談
 *  - consultation: 仕事の相談
 *  - 報告:         セッション終了時のレポート独白 (他 AI からの reply 期待)
 *  - ぼやき:       独り言 / つぶやき。低確率で AI が反応する
 *  - system:       Concordia 自身の通知 (replies 不要)
 *  - genius:       Genius (判断カード DB) の補完質問。作業の相談 (consultation) と
 *                  混ざると「答えるまで進めない」ように見えるので面を分ける。
 *                  未回答はセッション終了時にここへ回収する。
 */
export type ChatChannel = "chitchat" | "consultation" | "報告" | "ぼやき" | "system" | "genius";

export interface ChatMessageRow {
  id: number;
  channel: ChatChannel;
  session_id: string | null;
  author_label: string;
  ts: number;
  text: string;
  in_reply_to: number | null;
  is_actionable: number;
  metadata: string | null;
}

export class ChatRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: {
    channel: ChatChannel;
    session_id: string | null;
    author_label: string;
    text: string;
    in_reply_to: number | null;
    is_actionable: boolean;
    metadata?: string | null;
  }): ChatMessageRow {
    const ts = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO chat_messages(channel, session_id, author_label, ts, text, in_reply_to, is_actionable, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.channel,
        input.session_id,
        input.author_label,
        ts,
        input.text,
        input.in_reply_to,
        input.is_actionable ? 1 : 0,
        input.metadata ?? null,
      );
    return this.findById(Number(r.lastInsertRowid))!;
  }

  findById(id: number): ChatMessageRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM chat_messages WHERE id = ?`)
        .get(id) as ChatMessageRow | undefined) ?? null
    );
  }

  /**
   * 指定セッションが書いた直近のメッセージ 1 件。 standalone 絵文字 (🙏 等) を
   * 「直前のメッセージへのリアクション」として扱うときの対象解決に使う。
   */
  latestForSession(sessionId: string): ChatMessageRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM chat_messages WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1`)
        .get(sessionId) as ChatMessageRow | undefined) ?? null
    );
  }

  list(filter: {
    channel?: ChatChannel;
    since?: number;
    limit?: number;
  }): ChatMessageRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.channel) { where.push("channel = ?"); args.push(filter.channel); }
    if (filter.since !== undefined) { where.push("ts >= ?"); args.push(filter.since); }
    const sql =
      `SELECT * FROM chat_messages ` +
      `${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY ts DESC LIMIT ?`;
    args.push(filter.limit ?? 50);
    return this.db.prepare(sql).all(...args) as ChatMessageRow[];
  }
}
