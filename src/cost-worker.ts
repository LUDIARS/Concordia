import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./shared/config.js";
import { createChildLogger } from "./shared/logger.js";
import { openDb, closeDb } from "./db/index.js";
import { SessionsRepo } from "./db/sessions-repo.js";
import { makeDiscordConfigRepo } from "./db/discord-repo.js";
import { AdminState } from "./admin/state.js";
import { createCostRuntime, startCostWorkerLease } from "./bootstrap/cost.js";

const log = createChildLogger("cost-worker");

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

async function main(): Promise<void> {
  loadDotEnv(join(process.cwd(), ".env"));
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const sessions = new SessionsRepo(db);
  const configRepo = makeDiscordConfigRepo(db);
  const workspaceRootDefault = cfg.workspaceRoot || cfg.spawnDefaultCwd;
  const adminState = new AdminState(db, {
    workspaceRoot: workspaceRootDefault,
    workspaceRoots: cfg.workspaceRoots.length ? cfg.workspaceRoots : (workspaceRootDefault ? [workspaceRootDefault] : []),
    githubOrg: cfg.githubOrg,
    reactionWorkflowEnabled: process.env.CONCORDIA_REACTION_WORKFLOW === "1",
    lictorDevPath: workspaceRootDefault ? join(workspaceRootDefault, "Lictor") : "",
  });

  const lease = startCostWorkerLease(configRepo);
  const runtime = createCostRuntime({
    db,
    sessionsRepo: sessions,
    getDailyTokenBudget: () => adminState.getDailyTokenBudget(),
    log,
  });
  runtime.start();
  log.info("cost worker started");

  const shutdown = async () => {
    runtime.stop();
    lease.stop();
    closeDb();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
}

main().catch((err) => {
  log.error({ err }, "cost worker failed");
  process.exit(1);
});
