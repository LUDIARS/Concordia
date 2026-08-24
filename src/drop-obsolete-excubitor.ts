/** @implements spec/data/log-retention.md — VACUUM の停止確認・時間帯ガード */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  dropObsoleteExcubitorTables,
  findObsoleteExcubitorTables,
} from "./db/obsolete-excubitor-cleanup.js";
import { isQuietHours, QUIET_HOURS_END, QUIET_HOURS_START } from "./shared/quiet-hours.js";

interface Options {
  apply: boolean;
  confirmServicesStopped: boolean;
  /** 深夜帯 (23:00–05:00) 以外での --apply を明示的に許可する。 */
  allowDaytime: boolean;
  dbPath: string;
  backupPath?: string;
}

function argumentValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseOptions(argv: string[]): Options {
  const dbPath = argumentValue(argv, "--db");
  if (!dbPath) throw new Error("--db <path> is required");
  const backupPath = argumentValue(argv, "--backup");
  return {
    apply: argv.includes("--apply"),
    confirmServicesStopped: argv.includes("--confirm-services-stopped"),
    allowDaytime: argv.includes("--allow-daytime"),
    dbPath: resolve(dbPath),
    backupPath: backupPath ? resolve(backupPath) : undefined,
  };
}

function usage(): string {
  return [
    "Dry-run:",
    "  npm run db:drop-obsolete-excubitor -- --db <concordia.db>",
    "Apply after stopping Concordia and every worker:",
    "  npm run db:drop-obsolete-excubitor -- --db <concordia.db> --backup <concordia.db.bak> --apply --confirm-services-stopped",
    "Daytime override (only when the maintenance window cannot be used):",
    "  append --allow-daytime",
  ].join("\n");
}

async function verifyBackup(db: Database.Database, backupPath: string): Promise<void> {
  await db.backup(backupPath);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const result = backup.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`backup integrity_check failed: ${String(result)}`);
  } finally {
    backup.close();
  }
}

export async function main(argv = process.argv.slice(2), now: Date = new Date()): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const options = parseOptions(argv);
  if (!existsSync(options.dbPath)) throw new Error(`database not found: ${options.dbPath}`);

  if (options.apply && !options.confirmServicesStopped) {
    throw new Error("--confirm-services-stopped is required for --apply");
  }
  // VACUUM / DROP は数十秒〜分単位で DB を占有する。 日中に走ると、 復帰した
  // サービス群の better-sqlite3 が同期ブロックされ event loop stall / health
  // timeout を誘発するため、 既定では深夜帯 (QUIET_HOURS) だけに限定する。
  if (options.apply && !options.allowDaytime && !isQuietHours(now)) {
    throw new Error(
      `--apply is limited to quiet hours (${QUIET_HOURS_START}:00–${String(QUIET_HOURS_END).padStart(2, "0")}:00). `
      + "Pass --allow-daytime to override explicitly.",
    );
  }
  if (options.apply && !options.backupPath) {
    throw new Error("--backup <path> is required for --apply");
  }
  const backupPath = options.backupPath;
  if (options.apply && options.backupPath === options.dbPath) {
    throw new Error("backup path must differ from database path");
  }
  if (options.apply && options.backupPath && existsSync(options.backupPath)) {
    throw new Error(`backup already exists: ${options.backupPath}`);
  }

  const db = new Database(options.dbPath, {
    readonly: !options.apply,
    fileMustExist: true,
  });
  try {
    const tables = findObsoleteExcubitorTables(db);
    if (!options.apply || tables.length === 0) {
      process.stdout.write(`${JSON.stringify({ mode: "dry-run", db: options.dbPath, tables })}\n`);
      return;
    }
    const beforeBytes = statSync(options.dbPath).size;
    await verifyBackup(db, backupPath!);
    const dropped = dropObsoleteExcubitorTables(db);
    const afterBytes = statSync(options.dbPath).size;
    process.stdout.write(`${JSON.stringify({
      mode: "applied",
      db: options.dbPath,
      backup: options.backupPath,
      dropped,
      before_bytes: beforeBytes,
      after_bytes: afterBytes,
      reclaimed_bytes: Math.max(0, beforeBytes - afterBytes),
    })}\n`);
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
