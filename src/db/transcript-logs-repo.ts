/**
 * transcript_logs — Lictor の transcript-tail が送る Claude/Codex JSONL frame の
 * per-session 永続ストレージ.
 *
 * 設計メモ:
 *  - session_events (discrete signal) とは別 table に分離.
 *    1 session で数百〜数千 frame になり得るので、 events feed の S/N を保つため.
 *  - (session_id, seq) UNIQUE で冪等性確保. tail の再送 / 重複 POST を吸収.
 *  - kind は Lictor の transcript-tail が抽出する `text` / `tool-use` /
 *    `tool-result` / `thinking` / `summary` / `system` / `raw` のいずれか.
 *  - payload は frame の raw object を JSON 文字列化したもの.
 */

import type Database from "better-sqlite3";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("transcript-logs-repo");

export interface TranscriptLogRow {
  id: number;
  session_id: string;
  seq: number;
  ts: number;
  kind: string;
  /** Raw JSON string. listBySession の戻り値では parse 済 unknown に変換される. */
  payload: string;
}

export interface TranscriptLogEntry {
  id: number;
  seq: number;
  ts: number;
  kind: string;
  payload: unknown;
}

interface QueuedFrame {
  session_id: string;
  seq: number;
  ts: number;
  kind: string;
  payload: string;
}

/** 1 回の setImmediate tick で flush する最大行数. これを超える分は次 tick に回し、
 *  イベントループを長時間ブロックしないよう書き込みを分割する. */
const FLUSH_BATCH_SIZE = 200;
const FLUSH_RETRY_DELAY_MS = 1_000;

export class TranscriptLogsRepo {
  private readonly queue: QueuedFrame[] = [];
  private flushScheduled = false;
  private flushTimer: NodeJS.Immediate | null = null;
  private flushRetryTimer: NodeJS.Timeout | null = null;
  private lastFlushError: Error | null = null;
  private insertStmt: Database.Statement | null = null;
  private closed = false;

  constructor(private readonly db: Database.Database) {}

  /**
   * Insert one transcript frame.
   *
   * 同期 DB 書き込みが Cc のイベントループを長時間止めていた実障害
   * ([[2026-08-09-transcript-frame-event-loop-stall]]) を受け、実際の SQLite
   * 書き込みはメモリキューに積んで setImmediate ごとに分割 flush する。
   * 呼び出し元へは「キューに載った (=いずれ確実に書かれる)」時点で応答する。
   *
   * UNIQUE(session_id, seq) 違反 (= 重複 POST) は flush 側で黙って ignore する.
   * Lictor の transcript sink は timeout / ネットワーク失敗時に same seq で
   * 再送する (at-least-once)。 再送の 1 回目が実はサーバに届いていた場合、
   * 2 回目は重複になる — これは呼び出し側から見れば「永続化は完了している」
   * 正常系なので、 戻り値は「新規挿入か」ではなく **「引き受けたか」** を返す
   * (冪等成功)。 false を返すと、 requirePersisted な書き手 (codex
   * bootstrap の session binding) が再送のたびに失敗する (2026-07-12 実障害)。
   *
   * キュー投入から flush までの間にプロセスが落ちると、その間の frame は
   * ロストしうる (同期 insert 時代も commit 前クラッシュで同様のリスクは
   * あった)。 FLUSH_BATCH_SIZE を小さく保ち setImmediate 単位で即 flush する
   * ことで、この窓を実用上無視できる長さに抑える。
   */
  insert(input: {
    session_id: string;
    seq: number;
    ts: number;
    kind: string;
    payload: unknown;
  }): boolean {
    if (this.closed) throw new Error("TranscriptLogsRepo is closed");
    if (this.lastFlushError) throw this.lastFlushError;

    // JSON 化できない値を setImmediate 内で初めて発見すると、HTTP 応答後に
    // uncaught exception となる。受理前に検証し、呼び出し元の通常の失敗経路へ返す。
    const payload = JSON.stringify(input.payload ?? null);
    if (payload === undefined) throw new TypeError("transcript payload must be JSON serializable");
    this.queue.push({
      session_id: input.session_id,
      seq: input.seq,
      ts: input.ts,
      kind: input.kind,
      payload,
    });
    this.scheduleFlush();
    return true;
  }

  /** キューにある frame を同期 DB へ書き切る (テスト / graceful shutdown 用). */
  flushSync(): void {
    try {
      while (this.queue.length > 0) this.flushBatch();
      this.markFlushRecovered();
    } catch (error) {
      this.recordFlushFailure(error);
      throw error;
    }
  }

  /**
   * 保留中の setImmediate flush を止めて DB ハンドルへの参照を手放す.
   *
   * insert() 後、DB が close される前に必ず呼ぶこと。呼ばずに db.close() すると
   * 予約済みの flush tick が閉じたハンドルへ prepare() し、
   * "The database connection is not open" で落ちる (テストの afterEach で実際に発生)。
   * close 前にキューへ残っている frame は flushSync してから閉じる。
   */
  close(): void {
    if (this.flushTimer) clearImmediate(this.flushTimer);
    if (this.flushRetryTimer) clearTimeout(this.flushRetryTimer);
    this.flushTimer = null;
    this.flushRetryTimer = null;
    this.flushScheduled = false;
    this.closed = true;
    this.flushSync();
    this.insertStmt = null;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    this.flushTimer = setImmediate(() => this.runScheduledFlush());
  }

  private runScheduledFlush(): void {
    this.flushTimer = null;
    this.flushScheduled = false;
    if (this.closed || this.queue.length === 0) return;
    try {
      this.flushBatch();
      this.markFlushRecovered();
    } catch (error) {
      this.recordFlushFailure(error);
      return;
    }
    if (this.queue.length > 0) this.scheduleFlush();
  }

  private recordFlushFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    const canRetry = !this.closed && this.db.open;
    if (!this.lastFlushError) {
      log.error(
        { error: failure.message, queued_frames: this.queue.length, retry_scheduled: canRetry },
        "transcript log flush failed",
      );
    }
    this.lastFlushError = failure;
    if (!canRetry || this.flushRetryTimer) return;
    this.flushRetryTimer = setTimeout(() => {
      this.flushRetryTimer = null;
      this.scheduleFlush();
    }, FLUSH_RETRY_DELAY_MS);
    this.flushRetryTimer.unref?.();
  }

  private markFlushRecovered(): void {
    if (!this.lastFlushError) return;
    if (this.flushRetryTimer) clearTimeout(this.flushRetryTimer);
    this.flushRetryTimer = null;
    log.info({ queued_frames: this.queue.length }, "transcript log flush recovered");
    this.lastFlushError = null;
  }

  private flushBatch(): void {
    const batch = this.queue.slice(0, FLUSH_BATCH_SIZE);
    if (batch.length === 0) return;
    const stmt = this.getInsertStmt();
    const insertMany = this.db.transaction((frames: QueuedFrame[]) => {
      for (const frame of frames) {
        stmt.run(
          frame.session_id,
          frame.seq,
          frame.ts,
          frame.kind,
          frame.payload,
        );
      }
    });
    insertMany(batch);
    // transaction が失敗した場合は受理済み frame を失わない。成功後にだけ除去する。
    this.queue.splice(0, batch.length);
  }

  private getInsertStmt(): Database.Statement {
    if (!this.insertStmt) {
      this.insertStmt = this.db.prepare(
        `INSERT OR IGNORE INTO transcript_logs(session_id, seq, ts, kind, payload)
         VALUES (?, ?, ?, ?, ?)`,
      );
    }
    return this.insertStmt;
  }

  /**
   * Paginated listing for a session.
   *
   * 並び順は `ts ASC, seq ASC` (chronological). web monitor が読みやすい順.
   * since_id を指定すると id > since_id の行だけを返す (incremental tail 用).
   *
   * tail=true (かつ since_id 未指定) のときは「最新 limit 件」を時系列順で返す.
   *   数千 frame あるセッションを開いたとき、 先頭 (起動直後の raw frame) ではなく
   *   直近の作業が見えるようにするための既定モード. 内側で DESC LIMIT して新しい順に
   *   切り出し、 外側で ASC に並べ直す (表示は chronological のまま).
   * since_id 指定時は incremental tail なので tail は無視する (古い→新しいで積み増す).
   */
  listBySession(
    session_id: string,
    opts: { since_id?: number; limit?: number; tail?: boolean } = {},
  ): TranscriptLogEntry[] {
    // flush 前の未反映 frame を読み逃さないよう、読み取り直前に同期 flush する.
    // 読み取りは一覧表示/compaction 契機のみで高頻度パスではないため許容する.
    this.flushSync();
    const limit = clampLimit(opts.limit);
    const hasSince =
      typeof opts.since_id === "number" && Number.isFinite(opts.since_id);

    let rows: Array<{ id: number; seq: number; ts: number; kind: string; payload: string }>;
    if (opts.tail && !hasSince) {
      rows = this.db
        .prepare(
          `SELECT id, seq, ts, kind, payload FROM (
             SELECT id, seq, ts, kind, payload FROM transcript_logs
              WHERE session_id = ?
              ORDER BY ts DESC, seq DESC
              LIMIT ?
           ) ORDER BY ts ASC, seq ASC`,
        )
        .all(session_id, limit) as typeof rows;
    } else {
      const params: unknown[] = [session_id];
      let sql = `SELECT id, seq, ts, kind, payload FROM transcript_logs WHERE session_id = ?`;
      if (hasSince) {
        sql += ` AND id > ?`;
        params.push(opts.since_id);
      }
      sql += ` ORDER BY ts ASC, seq ASC LIMIT ?`;
      params.push(limit);
      rows = this.db.prepare(sql).all(...params) as typeof rows;
    }

    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      payload: safeParse(r.payload),
    }));
  }

  /**
   * Min/Max ts for a session (null if no frames).
   * session 行が purge 済みでも transcript が残っている孤児セッションに対し、
   * 閲覧用の synthetic session (開始/終了時刻) を組み立てるのに使う.
   */
  tsSpan(session_id: string): { first_ts: number; last_ts: number } | null {
    this.flushSync();
    const row = this.db
      .prepare(
        `SELECT MIN(ts) AS f, MAX(ts) AS l FROM transcript_logs WHERE session_id = ?`,
      )
      .get(session_id) as { f: number | null; l: number | null };
    if (row.f == null || row.l == null) return null;
    return { first_ts: row.f, last_ts: row.l };
  }

  /**
   * Highest row id for a session (0 if none).
   * compaction の elicit が inject 前の watermark を取り、 以後の frame だけ捕捉するのに使う.
   */
  maxId(session_id: string): number {
    this.flushSync();
    const row = this.db
      .prepare(`SELECT MAX(id) AS m FROM transcript_logs WHERE session_id = ?`)
      .get(session_id) as { m: number | null };
    return row.m ?? 0;
  }

  countBySession(session_id: string): number {
    this.flushSync();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM transcript_logs WHERE session_id = ?`)
      .get(session_id) as { n: number };
    return row.n;
  }

  /**
   * codex-sdk (Satelles) が turn ごとに送る `codex_usage` frame の生 payload。
   *
   * codex-cli は rollout JSONL を後追いして集計できるが、codex-sdk は
   * ファイルを書かない (rollout tail を持たないのが Satelles の存在意義)ので、
   * このセッションのトークンはこの frame にしか無い。新しい順に返し、
   * 呼び出し側が最大値を採る。
   *
   * kind は絞らない: kind は送信側 (Satelles) が自由文字列で決める値なので
   * (TranscriptFrameSchema は `string` しか要求しない)、特定値に依存すると
   * 送信側の表記が変わった瞬間に「常に 0 トークン」へ黙って劣化する。
   * LIKE で候補を絞り、type の最終判定は readUsageFrames 側で行う。
   * パターンに key ごと (`"type":"codex_usage"`) 含めるのは、 payload の
   * JSON 化がこの repo 側の JSON.stringify (空白なし) に固定されているため
   * 取りこぼしが無く、 かつ「本文に codex_usage という語が出てくるだけの
   * text frame」 が limit 窓を埋めて実 frame を追い出すのを防げるため。
   *
   * limit は新しい順の打ち切り。 thread ごとの累積値は新しいものほど大きいので、
   * 打ち切っても現行 thread の最大値は必ず窓に入る。 ただし usage frame が limit
   * を超えるほど長いセッションでは、 古い thread が窓の外へ落ちて過少計上になる
   * (レポート表示用の概算なので許容。 正確さが要るなら limit を上げる)。
   */
  /**
   * payload 本文に needle を含む frame を新しい順に返す。
   *
   * Cc 停止中に transcript へ残された宣言 (spec/feature/escalation-mode.md §1) を
   * 復帰後の tick が拾うための走査口。 LIKE の全表走査になるので、 呼び出し側は
   * 必ず sinceTs で範囲を絞る。
   */
  listFramesContaining(
    needle: string,
    opts: { sinceTs?: number; limit?: number } = {},
  ): TranscriptLogRow[] {
    this.flushSync();
    const limit = clampLimit(opts.limit);
    const params: unknown[] = [`%${needle}%`];
    let sql = `SELECT id, session_id, seq, ts, kind, payload FROM transcript_logs WHERE payload LIKE ?`;
    if (typeof opts.sinceTs === "number" && Number.isFinite(opts.sinceTs)) {
      sql += ` AND ts >= ?`;
      params.push(opts.sinceTs);
    }
    sql += ` ORDER BY ts ASC, seq ASC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as TranscriptLogRow[];
  }

  listUsagePayloads(session_id: string, limit = 500): unknown[] {
    this.flushSync();
    const rows = this.db
      .prepare(
        `SELECT payload FROM transcript_logs
          WHERE session_id = ? AND payload LIKE '%"type":"codex_usage"%'
          ORDER BY ts DESC, seq DESC
          LIMIT ?`,
      )
      .all(session_id, limit) as Array<{ payload: string }>;
    return rows.map((r) => safeParse(r.payload));
  }

  /** Storage 管理用: 全 session の cutoff より古い frame を削除する. */
  purgeOlderThan(cutoffTs: number): number {
    // purge must include frames accepted by insert() but not yet flushed.
    this.flushSync();
    const result = this.db.prepare(`DELETE FROM transcript_logs WHERE ts < ?`).run(cutoffTs);
    return Number(result.changes ?? 0);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), 1000);
}
