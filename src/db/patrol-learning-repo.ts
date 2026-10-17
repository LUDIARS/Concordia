/**
 * 巡回チャットの学習の永続 (spec/plan/2026-10-15-patrol-learning-design.md)。
 * - 断片: 発言 1 件 (msg:<chat id>) / 閉じた会話 1 件 (conv:<conversation id>) ごとに 1 行。 原文は持たない
 * - 学習 run: rule × 日で 1 回 (UNIQUE)
 */

import type Database from "better-sqlite3";

export type FragmentKind = "message" | "conversation";

export interface LearningFragmentRow {
  id: number;
  rule_id: string;
  kind: FragmentKind;
  source_key: string;
  status: "ok" | "failed";
  /** JSON。 */
  signal: string | null;
  created_at: number;
  consumed_by: string | null;
}

export type LearningRunStatus = "applied" | "skipped" | "rejected" | "failed";

export interface LearningRunRow {
  run_id: string;
  rule_id: string;
  day: string;
  status: LearningRunStatus;
  fragment_count: number;
  proposal: string | null;
  applied: string | null;
  reason: string | null;
  revision: number | null;
  created_at: number;
}

/** 学習 run が使った会話 1 件 (発言: text = 発言本文 / 会話: text = 巡回の投稿、 replies = 返信)。 */
export interface LearningSourceRow {
  kind: FragmentKind;
  /** JSON (断片の要点: ジャンル・反応の人数など)。 */
  signal: string | null;
  created_at: number;
  text: string | null;
  /** 発言が返信だったときの返信先の本文。 */
  reply_to_text: string | null;
  replies: string[];
}

/** 断片を作る前の、 巡回会話へ受理された人間の返信。 */
export interface PendingReplyForFragment {
  inbound_chat_id: number;
  rule_id: string;
  text: string;
}

/** 断片を作る前の、 閉じた巡回会話。 */
export interface ClosedConversationForFragment {
  conversation_id: string;
  rule_id: string;
  root_chat_id: number;
  reply_count: number;
  unprompted_count: number;
}

export class PatrolLearningRepo {
  constructor(private readonly db: Database.Database) {}

  /** まだ断片にしていない返信 (since 以降に受理したもの)。 */
  pendingReplies(sinceSec: number, limit: number): PendingReplyForFragment[] {
    return this.db.prepare(
      `SELECT ri.inbound_chat_id AS inbound_chat_id, rc.rule_id AS rule_id, cm.text AS text
         FROM rule_inbound ri
         JOIN rule_conversations rc ON rc.conversation_id = ri.conversation_id
         JOIN chat_messages cm ON cm.id = ri.inbound_chat_id
         LEFT JOIN patrol_learning_fragments f ON f.source_key = 'msg:' || ri.inbound_chat_id
        WHERE f.id IS NULL AND ri.received_at >= ?
        ORDER BY ri.inbound_chat_id
        LIMIT ?`,
    ).all(sinceSec, limit) as PendingReplyForFragment[];
  }

  /**
   * まだ断片にしていない、 巡回の投稿先チャンネル (個別チャンネル) の返信でない人間の会話 (neco 2026-10-15「全部拾う」)。
   * 返信は rule_inbound 側 (pendingReplies) で扱う。
   */
  pendingChannelMessages(sinceSec: number, limit: number): Array<{ chat_id: number; discord_channel_id: string; text: string }> {
    return this.db.prepare(
      `SELECT cm.id AS chat_id, json_extract(cm.metadata, '$.patrol_discord_channel_id') AS discord_channel_id, cm.text AS text
         FROM chat_messages cm
         LEFT JOIN patrol_learning_fragments f ON f.source_key = 'msg:' || cm.id
        WHERE f.id IS NULL AND cm.ts >= ? AND cm.in_reply_to IS NULL
          AND json_valid(cm.metadata)
          AND json_extract(cm.metadata, '$.source') = 'discord'
          AND COALESCE(json_extract(cm.metadata, '$.discord_user_id'), '') <> ''
          AND COALESCE(json_extract(cm.metadata, '$.patrol_discord_channel_id'), '') <> ''
        ORDER BY cm.id
        LIMIT ?`,
    ).all(sinceSec, limit) as Array<{ chat_id: number; discord_channel_id: string; text: string }>;
  }

  /** まだ断片にしていない、 閉じた会話 (since 以降に作られたもの)。 */
  closedConversations(sinceSec: number, limit: number): ClosedConversationForFragment[] {
    return this.db.prepare(
      `SELECT rc.conversation_id, rc.rule_id, rc.root_chat_id, rc.reply_count, rc.unprompted_count
         FROM rule_conversations rc
         LEFT JOIN patrol_learning_fragments f ON f.source_key = 'conv:' || rc.conversation_id
        WHERE f.id IS NULL AND rc.status <> 'open' AND rc.created_at >= ?
        ORDER BY rc.created_at
        LIMIT ?`,
    ).all(sinceSec, limit) as ClosedConversationForFragment[];
  }

  /** 直近の発言の断片に出た話題のキーワード (直近の話題の減点に使う)。 */
  recentKeywords(ruleId: string, sinceSec: number): Array<{ keyword: string; created_at: number }> {
    const rows = this.db.prepare(
      `SELECT signal, created_at FROM patrol_learning_fragments
        WHERE rule_id = ? AND kind = 'message' AND status = 'ok' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 200`,
    ).all(ruleId, sinceSec) as Array<{ signal: string | null; created_at: number }>;
    const out: Array<{ keyword: string; created_at: number }> = [];
    for (const r of rows) {
      try {
        const keywords = (JSON.parse(r.signal ?? "{}") as { keywords?: unknown }).keywords;
        if (Array.isArray(keywords)) for (const k of keywords) if (typeof k === "string" && k) out.push({ keyword: k, created_at: r.created_at });
      } catch {
        // 読めない断片は使わない
      }
    }
    return out;
  }

  countMessageFragmentsSince(ruleId: string, sinceSec: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM patrol_learning_fragments WHERE rule_id = ? AND kind = 'message' AND created_at >= ?`,
    ).get(ruleId, sinceSec) as { n: number };
    return row.n;
  }

  /** 同じ発言・会話は 1 度だけ (source_key UNIQUE)。 入れられたら true。 */
  insertFragment(input: { rule_id: string; kind: FragmentKind; source_key: string; status: "ok" | "failed"; signal: unknown; now: number }): boolean {
    const r = this.db.prepare(
      `INSERT INTO patrol_learning_fragments(rule_id, kind, source_key, status, signal, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_key) DO NOTHING`,
    ).run(input.rule_id, input.kind, input.source_key, input.status, input.signal === null ? null : JSON.stringify(input.signal), input.now);
    return Number(r.changes ?? 0) > 0;
  }

  /** 学習にまだ使っていない、 読めた断片。 */
  unconsumed(ruleId: string, limit = 200): LearningFragmentRow[] {
    return this.db.prepare(
      `SELECT * FROM patrol_learning_fragments
        WHERE rule_id = ? AND consumed_by IS NULL AND status = 'ok'
        ORDER BY created_at LIMIT ?`,
    ).all(ruleId, limit) as LearningFragmentRow[];
  }

  consume(ids: readonly number[], runId: string): void {
    const stmt = this.db.prepare(`UPDATE patrol_learning_fragments SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL`);
    const tx = this.db.transaction(() => { for (const id of ids) stmt.run(runId, id); });
    tx();
  }

  hasRun(ruleId: string, day: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM patrol_learning_runs WHERE rule_id = ? AND day = ?`).get(ruleId, day);
  }

  /** rule × 日で 1 回だけ記録できる。 既にあれば false。 */
  recordRun(row: Omit<LearningRunRow, "created_at"> & { now: number }): boolean {
    const r = this.db.prepare(
      `INSERT INTO patrol_learning_runs(run_id, rule_id, day, status, fragment_count, proposal, applied, reason, revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id, day) DO NOTHING`,
    ).run(row.run_id, row.rule_id, row.day, row.status, row.fragment_count, row.proposal, row.applied, row.reason, row.revision, row.now);
    return Number(r.changes ?? 0) > 0;
  }

  listRuns(ruleId: string, limit = 30): LearningRunRow[] {
    return this.db.prepare(
      `SELECT * FROM patrol_learning_runs WHERE rule_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(ruleId, Math.min(Math.max(1, limit), 100)) as LearningRunRow[];
  }

  /** 学習 run のある直近の日 (新しい順)。 */
  recentLearningDays(limit: number): string[] {
    return (this.db.prepare(
      `SELECT DISTINCT day FROM patrol_learning_runs ORDER BY day DESC LIMIT ?`,
    ).all(Math.min(Math.max(1, limit), 60)) as Array<{ day: string }>).map((r) => r.day);
  }

  /** その日の全 rule の学習 run (Memoria の日記へ載せる)。 */
  listRunsByDay(day: string): LearningRunRow[] {
    return this.db.prepare(
      `SELECT * FROM patrol_learning_runs WHERE day = ? ORDER BY rule_id ASC`,
    ).all(day) as LearningRunRow[];
  }

  /**
   * 学習 run が使った会話 (断片の元の発言)。 断片は原文を持たないので、 表示のときだけ会話記録から引く。
   * 発言者の名前は返さない。 消えた発言は text = null。
   */
  sourcesForRun(runId: string): LearningSourceRow[] {
    const fragments = this.db.prepare(
      `SELECT kind, source_key, signal, created_at FROM patrol_learning_fragments
        WHERE consumed_by = ? ORDER BY created_at, id`,
    ).all(runId) as Array<{ kind: FragmentKind; source_key: string; signal: string | null; created_at: number }>;
    const message = this.db.prepare(
      `SELECT cm.text AS text, parent.text AS reply_to_text
         FROM chat_messages cm LEFT JOIN chat_messages parent ON parent.id = cm.in_reply_to
        WHERE cm.id = ?`,
    );
    const root = this.db.prepare(
      `SELECT cm.text AS text FROM rule_conversations rc JOIN chat_messages cm ON cm.id = rc.root_chat_id
        WHERE rc.conversation_id = ?`,
    );
    const replies = this.db.prepare(
      `SELECT cm.text AS text FROM rule_inbound ri JOIN chat_messages cm ON cm.id = ri.inbound_chat_id
        WHERE ri.conversation_id = ? ORDER BY ri.inbound_chat_id LIMIT 10`,
    );
    return fragments.map((f) => {
      const base = { kind: f.kind, signal: f.signal, created_at: f.created_at };
      if (f.kind === "message") {
        const row = message.get(Number(f.source_key.slice("msg:".length))) as { text: string; reply_to_text: string | null } | undefined;
        return { ...base, text: row?.text ?? null, reply_to_text: row?.reply_to_text ?? null, replies: [] };
      }
      const conversationId = f.source_key.slice("conv:".length);
      const post = root.get(conversationId) as { text: string } | undefined;
      const rows = replies.all(conversationId) as Array<{ text: string }>;
      return { ...base, text: post?.text ?? null, reply_to_text: null, replies: rows.map((r) => r.text) };
    });
  }

  recentFragments(ruleId: string, limit = 50): LearningFragmentRow[] {
    return this.db.prepare(
      `SELECT * FROM patrol_learning_fragments WHERE rule_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(ruleId, Math.min(Math.max(1, limit), 200)) as LearningFragmentRow[];
  }
}
