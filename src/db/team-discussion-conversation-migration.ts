import type { NumberedMigration } from "./migrator.js";

export const teamDiscussionConversationMigration: NumberedMigration = {
  version: 164,
  name: "team-discussion-facilitation",
  source: "scoped discussion posts and channel facilitation checkpoints v1",
  up(db) {
    db.exec(`
      ALTER TABLE team_discussion_messages ADD COLUMN guild_id TEXT;
      ALTER TABLE team_discussion_messages ADD COLUMN surface_id TEXT;
      ALTER TABLE team_discussion_messages ADD COLUMN created_at INTEGER;
      CREATE INDEX team_discussion_message_history
        ON team_discussion_messages(guild_id, team_id, channel_id, length(message_id), message_id);
      CREATE TABLE team_discussion_facilitation (
        guild_id TEXT NOT NULL,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        current_summary TEXT NOT NULL DEFAULT '',
        delivered_through TEXT NOT NULL DEFAULT '',
        evaluated_through TEXT NOT NULL DEFAULT '',
        attempt_through TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'ready', 'sending', 'done', 'unknown', 'failed')),
        delta TEXT,
        proposed_summary TEXT,
        receipt_ids TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(guild_id, team_id, channel_id)
      );
    `);
  },
};
