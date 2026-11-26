// @spec チーム相談のファシリテーション
import type { Database } from "better-sqlite3";
import type { DiscussionDecision, DiscussionReceipt } from "./policy.js";

export interface DiscussionScope {
  teamId: string;
  channelId: string;
  surfaceId: string;
}

export interface DiscussionCandidate extends DiscussionScope {
  latestId: string;
  lastPostAt: number;
  currentSummary: string;
  evaluatedThrough: string;
  previousAttempt: string | null;
  state: "ready" | "pending";
  delta: string | null;
  proposedSummary: string | null;
  receiptIds: string;
}

interface DiscussionPost {
  id: string;
  content: string;
}

type Checkpoint = { through: string; summary: string };

export class DiscussionFacilitationRepository {
  constructor(private readonly db: Database, private readonly guildId: string, private readonly subsidiaryId: string | null) {}

  candidates(): DiscussionCandidate[] {
    return this.db.prepare(`
      WITH posts AS (
        SELECT m.guild_id, m.team_id, m.channel_id, m.surface_id, m.message_id, m.created_at, row_number() OVER (
          PARTITION BY m.team_id, m.channel_id ORDER BY length(m.message_id) DESC, m.message_id DESC
        ) AS rank
        FROM team_discussion_messages m
        JOIN teams t ON t.id = m.team_id
        JOIN team_surfaces s ON s.team_id = m.team_id AND s.channel_id = m.surface_id
        WHERE m.guild_id = ? AND t.subsidiary_id IS ? AND m.created_at IS NOT NULL
      )
      SELECT p.team_id AS teamId, p.channel_id AS channelId, p.surface_id AS surfaceId,
        CASE WHEN f.state = 'ready' THEN f.attempt_through ELSE p.message_id END AS latestId,
        p.created_at AS lastPostAt, coalesce(f.current_summary, '') AS currentSummary,
        coalesce(f.evaluated_through, '') AS evaluatedThrough, f.attempt_through AS previousAttempt,
        CASE WHEN f.state = 'ready' THEN 'ready' ELSE 'pending' END AS state,
        f.delta, f.proposed_summary AS proposedSummary, coalesce(f.receipt_ids, '[]') AS receiptIds
      FROM posts p
      LEFT JOIN team_discussion_facilitation f USING (guild_id, team_id, channel_id)
      WHERE p.rank = 1 AND (f.surface_id IS NULL OR f.surface_id = p.surface_id)
        AND (f.state IS NULL OR f.state = 'ready'
          OR (f.state IN ('done', 'failed') AND (length(p.message_id), p.message_id) >
              (length(f.attempt_through), f.attempt_through)))
      ORDER BY f.state = 'ready' DESC, p.created_at, p.message_id
    `).all(this.guildId, this.subsidiaryId) as DiscussionCandidate[];
  }

  claim(job: DiscussionCandidate): boolean {
    return this.db.prepare(`
      INSERT INTO team_discussion_facilitation(guild_id, team_id, channel_id, surface_id, attempt_through, state)
      SELECT @guild, @teamId, @channelId, @surfaceId, @latestId, 'running'
      WHERE NOT EXISTS (
        SELECT 1 FROM team_discussion_messages
        WHERE guild_id=@guild AND team_id=@teamId AND channel_id=@channelId AND surface_id=@surfaceId
          AND (length(message_id), message_id) > (length(@latestId), @latestId))
      ON CONFLICT(guild_id, team_id, channel_id) DO UPDATE SET state='running',
        attempt_through=excluded.attempt_through, delta=NULL, proposed_summary=NULL, receipt_ids='[]'
      WHERE state IN ('done', 'failed') AND attempt_through IS @previousAttempt
    `).run(this.key(job)).changes === 1;
  }

  posts(job: DiscussionCandidate): DiscussionPost[] {
    return this.db.prepare(`
      SELECT message_id AS id, content FROM team_discussion_messages
      WHERE guild_id=@guild AND team_id=@teamId AND channel_id=@channelId AND surface_id=@surfaceId
        AND (length(message_id), message_id) > (length(@evaluatedThrough), @evaluatedThrough)
        AND (length(message_id), message_id) <= (length(@latestId), @latestId)
      ORDER BY length(message_id), message_id
    `).all(this.key(job)) as DiscussionPost[];
  }

  saveDecision(job: DiscussionCandidate, decision: DiscussionDecision | null): void {
    const state = !decision ? "failed" : decision.has_diff ? "ready" : "done";
    this.db.prepare(`
      UPDATE team_discussion_facilitation SET state=@state, delta=@delta, proposed_summary=@proposed,
        evaluated_through=CASE WHEN @state='done' THEN @latestId ELSE evaluated_through END
      WHERE guild_id=@guild AND team_id=@teamId AND channel_id=@channelId AND attempt_through=@latestId AND state='running'
    `).run({ ...this.key(job), state, delta: decision?.has_diff ? decision.summary : null,
      proposed: decision?.has_diff ? decision.current_summary : null });
  }

  claimDelivery(job: DiscussionCandidate): boolean {
    return this.db.prepare(`
      UPDATE team_discussion_facilitation SET state='sending'
      WHERE guild_id=@guild AND team_id=@teamId AND channel_id=@channelId AND attempt_through=@latestId
        AND state='ready' AND receipt_ids=@receiptIds
    `).run(this.key(job)).changes === 1;
  }

  saveDelivery(job: DiscussionCandidate, receipt: DiscussionReceipt | null, checkpoint: Checkpoint | null,
    state: "ready" | "done" | "failed" | "unknown"): void {
    const ids = JSON.parse(job.receiptIds) as string[];
    if (receipt) ids.push(receipt.id);
    this.db.prepare(`
      UPDATE team_discussion_facilitation SET state=@state, receipt_ids=@ids,
        current_summary=coalesce(@summary,current_summary),
        delivered_through=coalesce(@through,delivered_through),
        evaluated_through=coalesce(@through,evaluated_through)
      WHERE guild_id=@guild AND team_id=@teamId AND channel_id=@channelId AND attempt_through=@latestId AND state='sending'
    `).run({ ...this.key(job), state, ids: JSON.stringify(ids), summary: checkpoint?.summary ?? null,
      through: checkpoint?.through ?? null });
  }

  recover(): void {
    this.db.prepare(`
      UPDATE team_discussion_facilitation SET state=CASE state WHEN 'running' THEN 'failed' ELSE 'unknown' END
      WHERE guild_id=? AND state IN ('running','sending')
        AND EXISTS (SELECT 1 FROM teams t WHERE t.id=team_id AND t.subsidiary_id IS ?)
    `).run(this.guildId, this.subsidiaryId);
  }

  private key(job: DiscussionCandidate) {
    return { ...job, guild: this.guildId };
  }
}
