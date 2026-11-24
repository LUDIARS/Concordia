/**
 * Muse の試遊結果の中継台帳 (muse_playtest_relays) の保存口。 状態遷移はすべて条件付き UPDATE で、
 * 外れたら false を返す (呼び手が今の行を読み直す)。
 *
 * @implements spec/feature/playtest-review-notify.md — Muse の結果の中継
 */

import type Database from "better-sqlite3";
import type { AnnounceState, VoluptasState } from "../playtest-review/muse-relay-policy.js";

export interface MusePlaytestRelayRow {
  instruction_id: string;
  run_id: string | null;
  finished_at: string;
  review_json: string | null;
  voluptas_state: VoluptasState;
  voluptas_id: string | null;
  announce_state: AnnounceState;
  announce_result: string | null;
  error: string | null;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewRelay {
  instructionId: string;
  runId: string | null;
  finishedAt: string;
  reviewJson: string | null;
  voluptasState: VoluptasState;
  announceState: AnnounceState;
  error: string | null;
}

export interface MusePlaytestRelayStore {
  /** 初めての指令なら true。 既に載っていれば何もしない (CC-MUSE-RELAY-INV-01)。 */
  insertIfAbsent(row: NewRelay, now: number): boolean;
  find(instructionId: string): MusePlaytestRelayRow | null;
  findMany(instructionIds: readonly string[]): MusePlaytestRelayRow[];
  /** 保存の試みの結果を書く。 voluptas_state が pending のときだけ。 */
  recordSave(instructionId: string, next: { state: VoluptasState; voluptasId: string | null; error: string | null; attempts: number; nextAttemptAt: number | null }, now: number): boolean;
  /** 告知を送り始める印を付ける。 announce_state が pending のときだけ (二重告知の止め、CC-MUSE-RELAY-INV-04)。 */
  beginAnnounce(instructionId: string, now: number): boolean;
  /** 告知の結果を書く。 announce_state が announcing のときだけ。 */
  finishAnnounce(instructionId: string, next: { state: AnnounceState; result: string | null; error: string | null }, now: number): boolean;
  /** 告知の途中で止まった行 (announcing のまま) を結果不明の failed にして返す。 起動時に呼ぶ。 */
  abandonAnnouncing(error: string, now: number): MusePlaytestRelayRow[];
  /** 進められる行 (保存の再試行の時刻が来た / 保存が確定して告知が未着手)。 */
  listDue(now: number, limit: number): MusePlaytestRelayRow[];
}

export class SqliteMusePlaytestRelayStore implements MusePlaytestRelayStore {
  constructor(private readonly db: Database.Database) {}

  insertIfAbsent(row: NewRelay, now: number): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO muse_playtest_relays
      (instruction_id, run_id, finished_at, review_json, voluptas_state, announce_state, error, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`)
      .run(row.instructionId, row.runId, row.finishedAt, row.reviewJson, row.voluptasState, row.announceState, row.error, now, now);
    return result.changes === 1;
  }

  find(instructionId: string): MusePlaytestRelayRow | null {
    return (this.db.prepare("SELECT * FROM muse_playtest_relays WHERE instruction_id = ?").get(instructionId) as MusePlaytestRelayRow | undefined) ?? null;
  }

  findMany(instructionIds: readonly string[]): MusePlaytestRelayRow[] {
    if (instructionIds.length === 0) return [];
    const marks = instructionIds.map(() => "?").join(", ");
    return this.db.prepare(`SELECT * FROM muse_playtest_relays WHERE instruction_id IN (${marks})`).all(...instructionIds) as MusePlaytestRelayRow[];
  }

  recordSave(instructionId: string, next: { state: VoluptasState; voluptasId: string | null; error: string | null; attempts: number; nextAttemptAt: number | null }, now: number): boolean {
    return this.db.prepare(`UPDATE muse_playtest_relays
      SET voluptas_state = ?, voluptas_id = ?, error = ?, attempts = ?, next_attempt_at = ?, updated_at = ?
      WHERE instruction_id = ? AND voluptas_state = 'pending'`)
      .run(next.state, next.voluptasId, next.error, next.attempts, next.nextAttemptAt, now, instructionId).changes === 1;
  }

  beginAnnounce(instructionId: string, now: number): boolean {
    return this.db.prepare(`UPDATE muse_playtest_relays SET announce_state = 'announcing', updated_at = ?
      WHERE instruction_id = ? AND announce_state = 'pending' AND voluptas_state <> 'pending'`)
      .run(now, instructionId).changes === 1;
  }

  finishAnnounce(instructionId: string, next: { state: AnnounceState; result: string | null; error: string | null }, now: number): boolean {
    return this.db.prepare(`UPDATE muse_playtest_relays SET announce_state = ?, announce_result = ?, error = COALESCE(?, error), updated_at = ?
      WHERE instruction_id = ? AND announce_state = 'announcing'`)
      .run(next.state, next.result, next.error, now, instructionId).changes === 1;
  }

  abandonAnnouncing(error: string, now: number): MusePlaytestRelayRow[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM muse_playtest_relays WHERE announce_state = 'announcing'").all() as MusePlaytestRelayRow[];
      const update = this.db.prepare(`UPDATE muse_playtest_relays SET announce_state = 'failed', error = ?, updated_at = ?
        WHERE instruction_id = ? AND announce_state = 'announcing'`);
      for (const row of rows) update.run(error, now, row.instruction_id);
      return rows.map((row) => ({ ...row, announce_state: "failed" as const, error, updated_at: now }));
    })();
  }

  listDue(now: number, limit: number): MusePlaytestRelayRow[] {
    return this.db.prepare(`SELECT * FROM muse_playtest_relays
      WHERE (voluptas_state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (voluptas_state <> 'pending' AND announce_state = 'pending')
      ORDER BY created_at LIMIT ?`).all(now, limit) as MusePlaytestRelayRow[];
  }
}
