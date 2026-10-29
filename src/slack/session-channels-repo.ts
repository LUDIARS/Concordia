import type { Database } from "better-sqlite3";

export interface SlackSessionChannelRow {
  session_id: string;
  channel_id: string;
  channel_name: string;
  header_ts: string | null;
  created_at: number;
  archive_due_at: number | null;
  archived_at: number | null;
}

export interface SlackSessionChannelsRepo {
  findBySessionId(sessionId: string): SlackSessionChannelRow | null;
  findByChannelId(channelId: string): SlackSessionChannelRow | null;
  upsert(input: {
    session_id: string;
    channel_id: string;
    channel_name: string;
    header_ts?: string | null;
    created_at?: number;
  }): void;
  setHeaderTs(sessionId: string, headerTs: string): void;
  scheduleArchive(sessionId: string, archiveDueAt: number): void;
  /** 予約済み archive を取り消す (session 再開等、 archive を実行してはいけなくなったとき)。 */
  cancelArchive(sessionId: string): void;
  listDueForArchive(now: number): SlackSessionChannelRow[];
  /**
   * archive 予約も archive もされていないのに、 session が終了済み・不明の channel。
   * session.ended を取りこぼした (停止中に終わった・session 行が消えた) channel を拾う。
   */
  listStaleUnscheduled(): SlackSessionChannelRow[];
  /**
   * 未実行の archive 予約のうち、 session が active に戻ったものを取り消す。
   * session.started を伴わない復帰 (lost → active) でも活動中の channel を archive しない。
   */
  cancelRevivedArchives(): number;
  markArchived(sessionId: string, archivedAt: number): void;
}

const epochSeconds = (): number => Math.floor(Date.now() / 1000);

export function makeSlackSessionChannelsRepo(
  db: Database,
  now: () => number = epochSeconds,
): SlackSessionChannelsRepo {
  return {
    findBySessionId(sessionId) {
      const row = db.prepare("SELECT * FROM slack_session_channels WHERE session_id = ?").get(sessionId) as
        | SlackSessionChannelRow
        | undefined;
      return row ?? null;
    },
    findByChannelId(channelId) {
      const row = db.prepare("SELECT * FROM slack_session_channels WHERE channel_id = ?").get(channelId) as
        | SlackSessionChannelRow
        | undefined;
      return row ?? null;
    },
    upsert(input) {
      db.prepare(
        `INSERT INTO slack_session_channels (
           session_id, channel_id, channel_name, header_ts, created_at, archive_due_at, archived_at
         ) VALUES (@session_id, @channel_id, @channel_name, @header_ts, @created_at, NULL, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           channel_id = excluded.channel_id,
           channel_name = excluded.channel_name,
           header_ts = COALESCE(excluded.header_ts, slack_session_channels.header_ts)`,
      ).run({
        ...input,
        header_ts: input.header_ts ?? null,
        created_at: input.created_at ?? now(),
      });
    },
    setHeaderTs(sessionId, headerTs) {
      db.prepare("UPDATE slack_session_channels SET header_ts = ? WHERE session_id = ?")
        .run(headerTs, sessionId);
    },
    scheduleArchive(sessionId, archiveDueAt) {
      db.prepare(
        `UPDATE slack_session_channels
            SET archive_due_at = ?, archived_at = NULL
          WHERE session_id = ?`,
      ).run(archiveDueAt, sessionId);
    },
    cancelArchive(sessionId) {
      db.prepare(
        `UPDATE slack_session_channels
            SET archive_due_at = NULL
          WHERE session_id = ?`,
      ).run(sessionId);
    },
    listDueForArchive(at) {
      return db.prepare(
        `SELECT * FROM slack_session_channels
          WHERE archive_due_at IS NOT NULL
            AND archive_due_at <= ?
            AND archived_at IS NULL
          ORDER BY archive_due_at ASC, created_at ASC`,
      ).all(at) as SlackSessionChannelRow[];
    },
    listStaleUnscheduled() {
      return db.prepare(
        `SELECT c.* FROM slack_session_channels c
           LEFT JOIN sessions s ON s.id = c.session_id
          WHERE c.archive_due_at IS NULL
            AND c.archived_at IS NULL
            AND (s.id IS NULL OR s.status <> 'active')
          ORDER BY c.created_at ASC`,
      ).all() as SlackSessionChannelRow[];
    },
    cancelRevivedArchives() {
      return db.prepare(
        `UPDATE slack_session_channels
            SET archive_due_at = NULL
          WHERE archive_due_at IS NOT NULL
            AND archived_at IS NULL
            AND session_id IN (SELECT id FROM sessions WHERE status = 'active')`,
      ).run().changes;
    },
    markArchived(sessionId, archivedAt) {
      db.prepare(
        `UPDATE slack_session_channels
            SET archived_at = ?, archive_due_at = NULL
          WHERE session_id = ?`,
      ).run(archivedAt, sessionId);
    },
  };
}
