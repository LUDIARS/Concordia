/**
 * GET /v1/teams/:id/discussion/messages/:messageId/attachments
 *
 * セクションチャンネルに貼られた画像・添付を、 取り込み (skills/discord-notion-sync) が使える形で返す。
 * 記録 (team_discussion_messages) にある投稿だけを対象にし、 取り直しと保存は fetcher (port) に任せる。
 * 読み取り専用 (Discord へは書かない)。 loopback 信頼境界の内側でだけ提供する。
 *
 * @implements spec/feature/discord-notion-sync.md — 画像・添付
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";
import type { TeamAttachmentFetcher } from "../shared/team-discussion-attachments.js";

const SNOWFLAKE = /^\d{15,25}$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface TeamDiscussionAttachmentsDeps {
  db: Database.Database;
  /** 未注入 (Discord 未設定) なら 503。 */
  fetcher?: TeamAttachmentFetcher;
}

export function teamDiscussionAttachmentsRouter(deps: TeamDiscussionAttachmentsDeps): Hono {
  const app = new Hono();

  app.get("/:id/discussion/messages/:messageId/attachments", async (c) => {
    const teamId = c.req.param("id");
    const messageId = c.req.param("messageId");
    if (!TEAM_ID.test(teamId) || !SNOWFLAKE.test(messageId)) return c.json({ error: "invalid_id" }, 400);
    const row = deps.db.prepare(`SELECT channel_id, attachments_json FROM team_discussion_messages
      WHERE team_id=? AND message_id=?`).get(teamId, messageId) as { channel_id: string; attachments_json: string } | undefined;
    if (!row) return c.json({ error: "not_found" }, 404);
    const view = { ref: `discord:${row.channel_id}/${messageId}`, channel_id: row.channel_id, message_id: messageId };
    if (!hasRecordedAttachments(row.attachments_json)) return c.json({ ...view, attachments: [] });
    if (!deps.fetcher) return c.json({ error: "discord_read_unavailable" }, 503);
    const result = await deps.fetcher.fetch({ teamId, channelId: row.channel_id, messageId });
    if (!result.ok) {
      return c.json(result.error === "store_failed" ? { error: result.error, detail: result.detail } : { error: result.error }, 502);
    }
    return c.json({ ...view, attachments: result.attachments });
  });

  return app;
}

function hasRecordedAttachments(json: string): boolean {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.length > 0;
  } catch {
    return false;
  }
}
