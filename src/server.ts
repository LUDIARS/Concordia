/**
 * Concordia backend エントリポイント.
 */

import { serve } from "@hono/node-server";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./shared/config.js";
import { createChildLogger } from "./shared/logger.js";
import { openDb, closeDb } from "./db/index.js";
import { SessionsRepo } from "./db/sessions-repo.js";
import { startSweeper } from "./sweeper.js";
import { buildApp } from "./app.js";

const log = createChildLogger("server");

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export interface BackendHandle {
  port: number;
  shutdown: () => Promise<void>;
}

export async function startBackend(): Promise<BackendHandle> {
  loadDotEnv(join(process.cwd(), ".env"));
  const cfg = loadConfig();
  const dbPath = cfg.dbPath || join(process.cwd(), "concordia.db");

  const db = openDb(dbPath);
  const repo = new SessionsRepo(db);

  const sweeper = startSweeper({
    repo,
    intervalMs: cfg.sweeperIntervalMs,
    lostAfterSec: cfg.lostAfterSec,
    abandonedAfterSec: cfg.abandonedAfterSec,
    purgeAfterDays: cfg.purgeAfterDays,
  });

  const app = buildApp({
    repo,
    config: cfg,
    startedAt: new Date().toISOString(),
    sweeperRunOnce: sweeper.runOnce,
  });

  const server = serve({
    fetch: app.fetch,
    hostname: cfg.host,
    port: cfg.port,
  });

  log.info(
    {
      host: cfg.host,
      port: cfg.port,
      dbPath,
      llm: cfg.anthropicApiKey ? "enabled" : "disabled",
    },
    "Concordia listening",
  );

  return {
    port: cfg.port,
    shutdown: async () => {
      sweeper.stop();
      server.close();
      closeDb();
    },
  };
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1] ?? "";
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  const url = import.meta.url;
  return url === `file://${norm}` || url === `file:///${norm}` || url.endsWith(norm);
}

if (isEntrypoint()) {
  startBackend().catch((err) => {
    log.error({ err }, "Concordia failed to start");
    process.exit(1);
  });
}
