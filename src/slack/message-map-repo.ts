// slack_message_map の最小 CRUD。
// (channel_id, ts) ↔ chat_messages.id を保持し、egress は投稿成功後に put、
// reaction_added 受信時に findChatId で元 chat を逆引きしてリアクション
// ワークフロー (👍 → 実装着手 等) に流す。discord_message_map と対の構成。
// schema.ts の slack_message_map が table の正本。

import type { Database } from "better-sqlite3";

const nowSec = (): number => Math.floor(Date.now() / 1000);

export interface SlackMessageMapRepo {
  /** Slack 投稿成功後に呼ぶ。既知の chat_messages.id を ts に紐付ける。 */
  put(channelId: string, ts: string, chatMessageId: number): void;
  /** reaction_added 受信時に chat_messages.id を逆引きする。未登録なら null。 */
  findChatId(channelId: string, ts: string): number | null;
}

export function makeSlackMessageMapRepo(db: Database): SlackMessageMapRepo {
  return {
    put(channelId, ts, chatMessageId) {
      db.prepare(
        `INSERT INTO slack_message_map (channel_id, ts, chat_message_id, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, ts) DO UPDATE SET chat_message_id = excluded.chat_message_id`,
      ).run(channelId, ts, chatMessageId, nowSec());
    },
    findChatId(channelId, ts) {
      const row = db
        .prepare("SELECT chat_message_id FROM slack_message_map WHERE channel_id = ? AND ts = ?")
        .get(channelId, ts) as { chat_message_id: number } | undefined;
      return row?.chat_message_id ?? null;
    },
  };
}
