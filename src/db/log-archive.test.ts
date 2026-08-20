import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { archiveAndPurgeOlderThan } from "./log-archive.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function makeDb(rowCount: number): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE transcript_logs (id INTEGER PRIMARY KEY, ts INTEGER, text TEXT)");
  const insert = db.prepare("INSERT INTO transcript_logs (ts, text) VALUES (?, ?)");
  for (let i = 0; i < rowCount; i += 1) insert.run(i, `row-${i}`);
  cleanup.push(() => db.close());
  return db;
}

function makeArchiveDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-log-archive-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** zip の最初のエントリを取り出す (この用途では 1 エントリしか入れない)。 */
function readFirstEntry(zip: Buffer): string {
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const compressedSize = zip.readUInt32LE(18);
  const start = 30 + nameLength + extraLength;
  return inflateRawSync(zip.subarray(start, start + compressedSize)).toString("utf8");
}

const spec = { table: "transcript_logs", tsExpression: "ts" };
const options = { chunkSize: 3, yieldToLoop: async () => undefined };

describe("archiveAndPurgeOlderThan", () => {
  it("writes the purged rows to a zip and deletes only those rows", async () => {
    const db = makeDb(10);
    const archiveDir = makeArchiveDir();

    const result = await archiveAndPurgeOlderThan(db, spec, 4, { ...options, archiveDir });

    expect(result).toMatchObject({ archived: 4, purged: 4, truncated: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_logs").get()).toEqual({ n: 6 });
    expect(db.prepare("SELECT MIN(ts) AS m FROM transcript_logs").get()).toEqual({ m: 4 });

    const files = readdirSync(archiveDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^transcript_logs-\d{8}-\d{6}-\d{3}\.zip$/);
    const lines = readFirstEntry(readFileSync(join(archiveDir, files[0]))).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0])).toMatchObject({ ts: 0, text: "row-0" });
    // rowid は DB 内部の識別子で、 復元にも解析にも使わない。 中身に混ぜない。
    expect(Object.keys(JSON.parse(lines[0]))).not.toContain("__rowid");
  });

  it("stops at the per-run cap and reports that rows remain", async () => {
    // 1 周期でイベントループを長時間止めない。 残りは次の周期で刈る。
    const db = makeDb(10);
    const archiveDir = makeArchiveDir();

    const first = await archiveAndPurgeOlderThan(db, spec, 10, {
      ...options,
      archiveDir,
      maxRowsPerRun: 4,
    });
    expect(first).toMatchObject({ archived: 4, purged: 4, truncated: true });

    const second = await archiveAndPurgeOlderThan(db, spec, 10, { ...options, archiveDir });
    expect(second).toMatchObject({ archived: 6, purged: 6, truncated: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_logs").get()).toEqual({ n: 0 });
    expect(readdirSync(archiveDir)).toHaveLength(2);
  });

  it("writes nothing when no row is old enough", async () => {
    const db = makeDb(3);
    const archiveDir = makeArchiveDir();

    const result = await archiveAndPurgeOlderThan(db, spec, 0, { ...options, archiveDir });

    expect(result).toEqual({ archived: 0, purged: 0, archivePath: null, truncated: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_logs").get()).toEqual({ n: 3 });
    expect(readdirSync(archiveDir)).toHaveLength(0);
  });

  it("keeps the rows when the archive cannot be written", async () => {
    // zip を残せないまま消すより、 溜めて次の周期に回す方が戻せる。
    const db = makeDb(5);

    // 通常ファイルを親に持つパスを退避先にして、 ディレクトリ作成を確実に失敗させる。
    const blocked = join(makeArchiveDir(), "blocker");
    writeFileSync(blocked, "not a directory");

    await expect(archiveAndPurgeOlderThan(db, spec, 5, {
      ...options,
      archiveDir: join(blocked, "sub"),
    })).rejects.toThrow();

    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_logs").get()).toEqual({ n: 5 });
  });

  it("keeps rows inserted while it yields between reading and deleting", async () => {
    // 読みと消しの間でイベントループへ返すので、 その隙に transcript_logs へ新しい行が
    // 入る。 rowid の範囲だけで消すと巻き込むため、 削除にも cutoff を再掲している。
    const db = makeDb(6);
    const archiveDir = makeArchiveDir();

    let inserted = false;
    const result = await archiveAndPurgeOlderThan(db, spec, 6, {
      ...options,
      archiveDir,
      // 退避対象 (ts < 6) と同じ rowid 帯へ、 保持期間内の行を割り込ませる。
      yieldToLoop: async () => {
        if (inserted) return;
        inserted = true;
        db.prepare("INSERT INTO transcript_logs (ts, text) VALUES (?, ?)").run(99, "fresh");
      },
    });

    expect(result).toMatchObject({ archived: 6, purged: 6 });
    // 割り込んだ行は cutoff を満たさないので残る。
    expect(db.prepare("SELECT ts, text FROM transcript_logs").all()).toEqual([
      { ts: 99, text: "fresh" },
    ]);
  });

  it("deletes every targeted row when the chunk size splits the batch", async () => {
    // chunkSize=3 / 10 行 = 範囲削除が 4 回に割れる。 境界の行を取りこぼさない。
    const db = makeDb(10);
    const archiveDir = makeArchiveDir();

    const result = await archiveAndPurgeOlderThan(db, spec, 10, { ...options, archiveDir });

    expect(result).toMatchObject({ archived: 10, purged: 10, truncated: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_logs").get()).toEqual({ n: 0 });
  });

  it("refuses table names and expressions that are not plain identifiers", async () => {
    const db = makeDb(1);
    const archiveDir = makeArchiveDir();

    await expect(archiveAndPurgeOlderThan(
      db,
      { table: "transcript_logs; DROP TABLE transcript_logs", tsExpression: "ts" },
      1,
      { ...options, archiveDir },
    )).rejects.toThrow(/Unsafe archive table name/);

    await expect(archiveAndPurgeOlderThan(
      db,
      { table: "transcript_logs", tsExpression: "ts) OR 1=1 --" },
      1,
      { ...options, archiveDir },
    )).rejects.toThrow(/Unsafe archive timestamp expression/);
  });
});
