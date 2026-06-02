// slack_session_threads の最小 CRUD。
// session_id ↔ (channel_id, thread_ts) を保持し、egress は thread に投稿、
// ingress は thread 返信 → session 逆引きに使う。schema.ts が table の正本。

import type { Database } from "better-sqlite3";

const nowSec = (): number => Math.floor(Date.now() / 1000);

export type SlackThreadStatus = "active" | "ended";

export interface SlackSessionThreadRow {
  session_id: string;
  channel_id: string;
  thread_ts: string;
  status: SlackThreadStatus;
  ts: number;
}

export interface SlackSessionThreadsRepo {
  findBySessionId(sessionId: string): SlackSessionThreadRow | null;
  findByThreadTs(channelId: string, threadTs: string): SlackSessionThreadRow | null;
  upsert(input: { session_id: string; channel_id: string; thread_ts: string; status?: SlackThreadStatus }): void;
  setStatus(sessionId: string, status: SlackThreadStatus): void;
}

export function makeSlackSessionThreadsRepo(db: Database): SlackSessionThreadsRepo {
  return {
    findBySessionId(sessionId) {
      const row = db
        .prepare("SELECT * FROM slack_session_threads WHERE session_id = ?")
        .get(sessionId) as SlackSessionThreadRow | undefined;
      return row ?? null;
    },
    findByThreadTs(channelId, threadTs) {
      const row = db
        .prepare("SELECT * FROM slack_session_threads WHERE channel_id = ? AND thread_ts = ?")
        .get(channelId, threadTs) as SlackSessionThreadRow | undefined;
      return row ?? null;
    },
    upsert(input) {
      db.prepare(
        `INSERT INTO slack_session_threads (session_id, channel_id, thread_ts, status, ts)
         VALUES (@session_id, @channel_id, @thread_ts, @status, @ts)
         ON CONFLICT(session_id) DO UPDATE SET
           channel_id = excluded.channel_id,
           thread_ts  = excluded.thread_ts,
           status     = excluded.status`,
      ).run({
        session_id: input.session_id,
        channel_id: input.channel_id,
        thread_ts: input.thread_ts,
        status: input.status ?? "active",
        ts: nowSec(),
      });
    },
    setStatus(sessionId, status) {
      db.prepare("UPDATE slack_session_threads SET status = ? WHERE session_id = ?").run(status, sessionId);
    },
  };
}
