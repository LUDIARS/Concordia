import type { NumberedMigration } from "./migrator.js";

/**
 * セクションチャンネルの投稿の添付情報 (id・名前・種類・サイズ)。 画像・添付だけの投稿も記録するため
 * (2026-11-26 neco 指示「画像だけの投稿を無視しないようにして」)。 CDN の URL は期限付きなので持たない。
 */
export const teamDiscussionAttachmentsMigration: NumberedMigration = {
  version: 165,
  name: "team-discussion-attachments",
  source: "team_discussion_messages.attachments_json (画像・添付だけの投稿も記録)",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(team_discussion_messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "attachments_json")) {
      db.exec("ALTER TABLE team_discussion_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
    }
  },
};
