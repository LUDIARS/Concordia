/**
 * 保持期間を過ぎたログ行を zip へ退避してから削除する。
 *
 * `concordia.db` は 2026-08-09 に 1,191 MB、 2026-08-20 に 1,500 MB。 刈り込み自体は
 * sweeper にあったが、 保持期間の既定が 90 日で今の生成速度に追いつかず、 実質溜まり
 * 続けていた。 保持期間を 30 日へ短縮するにあたり、 消す前に zip で残す (neco 指定
 * 2026-08-20) — 参照頻度は低いが、 消えると後から追えない種類のログのため。
 *
 * Cc は `better-sqlite3` の同期 API を使うので、 巨大テーブルへ 1 本の DELETE を投げると
 * その間イベントループが止まる ([[2026-08-09-transcript-frame-event-loop-stall]])。
 * 読み取り・書き出し・削除をチャンクに割り、 チャンク間でループへ制御を返す。
 *
 * 順序は「読む → zip をディスクへ確定 → 消す」。 逆にすると、 退避の途中で落ちたときに
 * 行だけ消えて中身が残らない。
 *
 * SRP: 退避と削除の進行制御のみ。 どのテーブルをいつ刈るかは呼び出し側 (sweeper)。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { buildZip } from "../shared/zip-writer.js";

export interface ArchiveTableSpec {
  /** 対象テーブル名。 SQL へ直接埋めるので、 呼び出し側が持つ固定値だけを渡す。 */
  table: string;
  /** 保持期間の判定に使う列 (式可)。 これも固定値のみ。 */
  tsExpression: string;
}

export interface ArchivePurgeOptions {
  /** zip の出力先。 無ければ作る。 */
  archiveDir: string;
  /** 1 回の読み取り / 削除で触る行数。 */
  chunkSize?: number;
  /** 1 走査で退避する上限。 残りは次の周期へ回す (1 回のティックを長くしない)。 */
  maxRowsPerRun?: number;
  now?: () => Date;
  /** チャンク間でイベントループへ制御を返す。 テストでは同期に差し替える。 */
  yieldToLoop?: () => Promise<void>;
}

export interface ArchivePurgeResult {
  archived: number;
  purged: number;
  /** 退避先。 対象行が無ければ null。 */
  archivePath: string | null;
  /** 上限に当たって積み残した (次の周期で続きを刈る)。 */
  truncated: boolean;
}

const DEFAULT_CHUNK_SIZE = 2_000;
const DEFAULT_MAX_ROWS_PER_RUN = 50_000;

/** SQL へ埋め込む識別子は、 呼び出し側の固定値であることを型ではなく実行時にも確かめる。 */
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_SQL_EXPRESSION = /^[A-Za-z0-9_(), ]+$/;

function assertSafeSpec(spec: ArchiveTableSpec): void {
  if (!SAFE_SQL_IDENTIFIER.test(spec.table)) {
    throw new Error(`Unsafe archive table name: ${spec.table}`);
  }
  if (!SAFE_SQL_EXPRESSION.test(spec.tsExpression)) {
    throw new Error(`Unsafe archive timestamp expression: ${spec.tsExpression}`);
  }
}

/**
 * `transcript_logs-20260820-101500-123.zip` — テーブルと時刻で一意にし、 追記しない。
 * 同一秒内に複数回退避すると秒精度だけでは衝突するため、 ミリ秒も足す。
 */
function archiveFileName(table: string, now: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + `-${pad(now.getMilliseconds(), 3)}`;
  return `${table}-${stamp}.zip`;
}

const defaultYield = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

/**
 * `tsExpression < cutoffTs` の行を zip へ書き出してから削除する。
 * 対象が無ければ何も書かず `{ archived: 0, purged: 0, archivePath: null }` を返す。
 */
export async function archiveAndPurgeOlderThan(
  db: Database.Database,
  spec: ArchiveTableSpec,
  cutoffTs: number,
  options: ArchivePurgeOptions,
): Promise<ArchivePurgeResult> {
  assertSafeSpec(spec);
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxRows = options.maxRowsPerRun ?? DEFAULT_MAX_ROWS_PER_RUN;
  const now = (options.now ?? (() => new Date()))();
  const yieldToLoop = options.yieldToLoop ?? defaultYield;

  const select = db.prepare(
    `SELECT rowid AS __rowid, * FROM ${spec.table}
     WHERE ${spec.tsExpression} < ? AND rowid > ?
     ORDER BY rowid LIMIT ?`,
  );
  const deleteByRowidRange = db.prepare(
    `DELETE FROM ${spec.table}
     WHERE ${spec.tsExpression} < ? AND rowid > ? AND rowid <= ?`,
  );

  const lines: string[] = [];
  const rowIds: number[] = [];
  let cursor = 0;
  let truncated = false;

  for (;;) {
    const remaining = maxRows - rowIds.length;
    if (remaining <= 0) {
      // 上限に達した。 まだ対象が残っているかだけを 1 行で確かめる。
      // cursor は最後に読んだ rowid なので、 その先に 1 行でもあれば積み残し。
      truncated = select.all(cutoffTs, cursor, 1).length > 0;
      break;
    }
    const rows = select.all(cutoffTs, cursor, Math.min(chunkSize, remaining)) as Array<
      Record<string, unknown> & { __rowid: number }
    >;
    if (rows.length === 0) break;
    for (const row of rows) {
      const { __rowid, ...rest } = row;
      rowIds.push(__rowid);
      lines.push(JSON.stringify(rest));
    }
    cursor = rows[rows.length - 1].__rowid;
    await yieldToLoop();
  }

  if (rowIds.length === 0) {
    return { archived: 0, purged: 0, archivePath: null, truncated: false };
  }

  await mkdir(options.archiveDir, { recursive: true });
  const archivePath = join(options.archiveDir, archiveFileName(spec.table, now));
  const zip = buildZip(
    [{ name: `${spec.table}.jsonl`, data: Buffer.from(`${lines.join("\n")}\n`, "utf8") }],
    now,
  );
  // 削除は zip がディスクに載ってから。 ここで失敗したら 1 行も消さずに投げ返す。
  await writeFile(archivePath, zip);

  // 削除は rowid の範囲で行う。 IN (...) だと 1 文あたりのバインド変数上限
  // (SQLITE_MAX_VARIABLE_NUMBER) に chunkSize が縛られるうえ、 読みと消しの間に
  // 挟まる yield で入った新しい行を巻き込まないことを条件で担保できない。
  // `${tsExpression} < cutoff` を再掲しているのは、 退避した行だけを消すため
  // (同じ rowid 範囲に後から入った行は cutoff を満たさないので残る)。
  let purged = 0;
  let deleteFrom = 0;
  for (let i = 0; i < rowIds.length; i += chunkSize) {
    const deleteTo = rowIds[Math.min(i + chunkSize, rowIds.length) - 1];
    const result = deleteByRowidRange.run(cutoffTs, deleteFrom, deleteTo);
    purged += Number(result.changes ?? 0);
    deleteFrom = deleteTo;
    await yieldToLoop();
  }

  return { archived: rowIds.length, purged, archivePath, truncated };
}
