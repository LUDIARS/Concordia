import type Database from "better-sqlite3";

/**
 * 巡回チャットの会話状態 (spec/feature/patrol-chat.md §7)。
 *
 * - 会話 = root 投稿 1 件と、 その後の bot 発言・人間の返信の束
 * - rule_inbound は人間の返信 1 件につき 1 行 (PK)。 同じ返信へ二度応答しない / 再起動で再応答しない
 * - rule_conversation_messages は会話に属する bot 発言。 root 以外への返信も会話へ結び付ける
 */

export interface RuleConversationRow {
  conversation_id: string;
  rule_id: string;
  rule_revision: number;
  root_chat_id: number;
  channel: string;
  scope_key: string;
  source_ref: string | null;
  status: "open" | "closed";
  expires_at: number;
  last_bot_message_id: number;
  last_bot_at: number;
  reply_count: number;
  unprompted_count: number;
  created_at: number;
  updated_at: number;
}

export interface RuleInboundRow {
  inbound_chat_id: number;
  conversation_id: string;
  received_at: number;
  status: "pending" | "answered" | "dropped";
  run_id: string | null;
  reason: string | null;
}

export class RuleConversationsRepo {
  constructor(private readonly db: Database.Database) {}

  open(input: {
    conversation_id: string;
    rule_id: string;
    rule_revision: number;
    root_chat_id: number;
    channel: string;
    scope_key: string;
    source_ref: string | null;
    expires_at: number;
    now: number;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO rule_conversations(
             conversation_id, rule_id, rule_revision, root_chat_id, channel, scope_key, source_ref,
             status, expires_at, last_bot_message_id, last_bot_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO NOTHING`,
        )
        .run(
          input.conversation_id, input.rule_id, input.rule_revision, input.root_chat_id, input.channel,
          input.scope_key, input.source_ref, input.expires_at, input.root_chat_id, input.now, input.now, input.now,
        );
      this.addBotMessage(input.conversation_id, input.root_chat_id);
    })();
  }

  find(conversationId: string): RuleConversationRow | null {
    return (
      (this.db.prepare(`SELECT * FROM rule_conversations WHERE conversation_id = ?`).get(conversationId) as
        | RuleConversationRow
        | undefined) ?? null
    );
  }

  /** bot 発言 (root 含む) から会話を引く。 */
  findByBotMessage(chatMessageId: number): RuleConversationRow | null {
    const row = this.db
      .prepare(`SELECT conversation_id FROM rule_conversation_messages WHERE chat_message_id = ?`)
      .get(chatMessageId) as { conversation_id: string } | undefined;
    return row ? this.find(row.conversation_id) : null;
  }

  isBotMessage(chatMessageId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM rule_conversation_messages WHERE chat_message_id = ?`).get(chatMessageId);
  }

  addBotMessage(conversationId: string, chatMessageId: number): void {
    this.db
      .prepare(`INSERT INTO rule_conversation_messages(chat_message_id, conversation_id) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .run(chatMessageId, conversationId);
  }

  /** bot が会話へ発言した後の更新。 kind で返信回数 / 追投稿回数を数える。 */
  recordBotTurn(conversationId: string, chatMessageId: number, kind: "reply" | "followup", now: number): void {
    this.db.transaction(() => {
      this.addBotMessage(conversationId, chatMessageId);
      this.db
        .prepare(
          `UPDATE rule_conversations SET
             last_bot_message_id = ?, last_bot_at = ?, updated_at = ?,
             reply_count = reply_count + ?, unprompted_count = unprompted_count + ?
           WHERE conversation_id = ?`,
        )
        .run(chatMessageId, now, now, kind === "reply" ? 1 : 0, kind === "followup" ? 1 : 0, conversationId);
    })();
  }

  /** 人間の返信を受理する。 同じ inbound は一度だけ (false = 既知)。 */
  recordInbound(inboundChatId: number, conversationId: string, now: number): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO rule_inbound(inbound_chat_id, conversation_id, received_at) VALUES (?, ?, ?)
         ON CONFLICT(inbound_chat_id) DO NOTHING`,
      )
      .run(inboundChatId, conversationId, now);
    return Number(r.changes ?? 0) > 0;
  }

  /** 受信順の未処理返信 (指定 rule の会話のみ)。 */
  pendingInbound(ruleId: string): RuleInboundRow[] {
    return this.db
      .prepare(
        `SELECT i.* FROM rule_inbound i
         JOIN rule_conversations c ON c.conversation_id = i.conversation_id
         WHERE i.status = 'pending' AND c.rule_id = ?
         ORDER BY i.inbound_chat_id`,
      )
      .all(ruleId) as RuleInboundRow[];
  }

  /** 最後の bot 発言以降に受けた直接返信の数 (未処理含む)。 */
  inboundSince(conversationId: string, afterChatId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM rule_inbound WHERE conversation_id = ? AND inbound_chat_id > ?`)
      .get(conversationId, afterChatId) as { n: number };
    return row.n;
  }

  settleInbound(ids: readonly number[], status: "answered" | "dropped", runId: string | null, reason: string | null): void {
    const stmt = this.db.prepare(
      `UPDATE rule_inbound SET status = ?, run_id = ?, reason = ? WHERE inbound_chat_id = ? AND status = 'pending'`,
    );
    this.db.transaction(() => {
      for (const id of ids) stmt.run(status, runId, reason, id);
    })();
  }

  listOpen(ruleId: string, nowSec: number): RuleConversationRow[] {
    return this.db
      .prepare(`SELECT * FROM rule_conversations WHERE rule_id = ? AND status = 'open' AND expires_at > ? ORDER BY created_at`)
      .all(ruleId, nowSec) as RuleConversationRow[];
  }

  /** 期限切れの会話を閉じ、 その会話の未処理返信を理由付きで落とす。 */
  closeExpired(nowSec: number): number {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE rule_inbound SET status = 'dropped', reason = 'conversation expired'
           WHERE status = 'pending' AND conversation_id IN (
             SELECT conversation_id FROM rule_conversations WHERE status = 'open' AND expires_at <= ?)`,
        )
        .run(nowSec);
      const r = this.db
        .prepare(`UPDATE rule_conversations SET status = 'closed', updated_at = ? WHERE status = 'open' AND expires_at <= ?`)
        .run(nowSec, nowSec);
      return Number(r.changes ?? 0);
    })();
  }

  listInbound(conversationId: string): RuleInboundRow[] {
    return this.db
      .prepare(`SELECT * FROM rule_inbound WHERE conversation_id = ? ORDER BY inbound_chat_id`)
      .all(conversationId) as RuleInboundRow[];
  }
}
