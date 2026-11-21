import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { decodeAgyGeneration, decodeAgyStepTime, type AgyGeneration } from "./agy-usage-metadata.js";
import type { AgyUsageSnapshot } from "./agy-usage-database.js";

const MAX_ROWS = 2048;
const MAX_ROW_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

function readUsage(path: string): AgyUsageSnapshot {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    // One snapshot of the main database and live WAL. Never read steps.step_payload.
    db.exec("BEGIN");
    const stepTime = db.prepare<[number], { metadata: Buffer | null }>(
      "SELECT metadata FROM steps WHERE idx = ? AND length(metadata) <= 65536",
    );
    const prompt = db.prepare<[number], { idx: number }>(
      "SELECT idx FROM steps WHERE idx <= ? AND step_type = 14 AND status = 3 ORDER BY idx DESC LIMIT 1",
    );
    const scan = db.prepare<[number, number], { idx: number; data: Buffer | null }>(`
      SELECT idx, CASE WHEN length(data) <= ? THEN data END AS data
      FROM gen_metadata ORDER BY idx DESC LIMIT ?
    `);
    const rows: Array<AgyGeneration & { index: number }> = [];
    let lastIndex: number | null = null;
    let bytesRead = 0;
    for (const { idx, data } of scan.iterate(MAX_ROW_BYTES, MAX_ROWS)) {
      if (typeof idx !== "number" || !Number.isSafeInteger(idx) || idx < 0) continue;
      lastIndex ??= idx;
      if (!(data instanceof Uint8Array)) continue;
      bytesRead += data.byteLength;
      if (bytesRead > MAX_SCAN_BYTES) break;
      const row = decodeAgyGeneration(data);
      if (!row) continue;
      if (row.stepIndex !== null) {
        const turn = prompt.get(row.stepIndex)?.idx;
        row.turnIndex = typeof turn === "number" ? turn : null;
        if (row.atMs === null) {
          const step = stepTime.get(row.stepIndex)?.metadata;
          row.atMs = decodeAgyStepTime(step instanceof Uint8Array ? step : null);
        }
      }
      rows.push({ ...row, index: idx });
    }
    return { lastIndex, rows: rows.reverse() };
  } finally {
    db.close();
  }
}

parentPort?.postMessage(readUsage((workerData as { path: string }).path));
