/**
 * escalation_events — エスカレーションモードの監査記録 (spec/feature/escalation-mode.md §1).
 *
 * `sessions.escalation_mode` が「今そうであるか」だけを持つのに対し、 こちらは
 * 「誰がいつ何のために規律を外し、 いつ戻したか」 を期間として残す。 モードは記録であって
 * 権限昇格ではない、 という設計の実体がこのテーブル。
 *
 * 状態列 (sessions) と監査行 (escalation_events) は 1 トランザクションで動かす。
 * 片方だけ進むと「エスカレーション中だが理由が読めない」 行が残り、 後追いレビューが成立しない。
 */

import type Database from "better-sqlite3";

/** 宣言の出所。 `api` = Cc 稼働中の HTTP 宣言、 `transcript` = Cc 停止中の transcript record。 */
export type EscalationSource = "api" | "transcript";

export interface EscalationEventRow {
  id: number;
  session_id: string;
  actor: string;
  reason: string;
  started_at: number;
  ended_at: number | null;
  note: string | null;
  source: EscalationSource;
}

export interface StartEscalationInput {
  session_id: string;
  actor: string;
  reason: string;
  started_at?: number;
  source?: EscalationSource;
}

export interface EndEscalationInput {
  session_id: string;
  note?: string | null;
  ended_at?: number;
}

export class EscalationRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * エスカレーションを開始し、 開いたままの event 行を返す。
   * 既に開始済みなら既存の open event をそのまま返す (二重 start を新しい期間にしない)。
   */
  start(input: StartEscalationInput): EscalationEventRow {
    const startedAt = input.started_at ?? Math.floor(Date.now() / 1000);
    const source = input.source ?? "api";
    const run = this.db.transaction((): EscalationEventRow => {
      const open = this.findOpen(input.session_id);
      if (open) return open;
      const result = this.db
        .prepare(
          `INSERT INTO escalation_events(session_id, actor, reason, started_at, ended_at, note, source)
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(input.session_id, input.actor, input.reason, startedAt, source);
      this.db
        .prepare(`UPDATE sessions SET escalation_mode = 1 WHERE id = ?`)
        .run(input.session_id);
      return this.find(Number(result.lastInsertRowid))!;
    });
    return run();
  }

  /**
   * エスカレーションを解除する。 開いている event が無ければ null を返し、
   * `sessions.escalation_mode` だけは 0 に戻す (状態と記録の食い違いを残さない)。
   */
  end(input: EndEscalationInput): EscalationEventRow | null {
    const endedAt = input.ended_at ?? Math.floor(Date.now() / 1000);
    const run = this.db.transaction((): EscalationEventRow | null => {
      const open = this.findOpen(input.session_id);
      this.db
        .prepare(`UPDATE sessions SET escalation_mode = 0 WHERE id = ?`)
        .run(input.session_id);
      if (!open) return null;
      this.db
        .prepare(`UPDATE escalation_events SET ended_at = ?, note = ? WHERE id = ?`)
        .run(endedAt, input.note ?? null, open.id);
      return this.find(open.id)!;
    });
    return run();
  }

  find(id: number): EscalationEventRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM escalation_events WHERE id = ?`)
        .get(id) as EscalationEventRow | undefined) ?? null
    );
  }

  /** その session で開いたままの (= 解除されていない) event。 */
  findOpen(sessionId: string): EscalationEventRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM escalation_events
           WHERE session_id = ? AND ended_at IS NULL
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(sessionId) as EscalationEventRow | undefined) ?? null
    );
  }

  /** エスカレーション中の session id 一覧 (停止 claim の除外対象)。 */
  listEscalatedSessionIds(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM sessions WHERE escalation_mode = 1`)
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  isEscalated(sessionId: string): boolean {
    const row = this.db
      .prepare(`SELECT escalation_mode FROM sessions WHERE id = ?`)
      .get(sessionId) as { escalation_mode: number } | undefined;
    return (row?.escalation_mode ?? 0) === 1;
  }

  listBySession(sessionId: string, limit = 20): EscalationEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM escalation_events
         WHERE session_id = ?
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(sessionId, limit) as EscalationEventRow[];
  }

  /**
   * transcript 由来の宣言を取り込む際の重複判定。 同じ session / 同じ開始時刻の
   * event が既にあるなら作らない — tick は同じ transcript を何度も読むため。
   */
  hasEventStartedAt(sessionId: string, startedAt: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM escalation_events WHERE session_id = ? AND started_at = ? LIMIT 1`,
      )
      .get(sessionId, startedAt);
    return row !== undefined;
  }
}
