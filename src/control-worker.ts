/** Standalone durable OS-control queue consumer. */
import { hostname } from "node:os";
import { loadConfig } from "./shared/config.js";
import { createChildLogger } from "./shared/logger.js";
import { closeDb, openDb } from "./db/index.js";
import { ControlJobsRepo } from "./db/control-jobs-repo.js";
import { SessionsRepo } from "./db/sessions-repo.js";
import { ControlJobWorker, makeControlJobExecutor } from "./control/control-job-worker.js";

const log = createChildLogger("control-worker");

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const jobs = new ControlJobsRepo(db);
  const sessions = new SessionsRepo(db);
  const worker = new ControlJobWorker(jobs, {
    owner: `${hostname()}:${process.pid}`,
    executor: makeControlJobExecutor({ sessions }),
  });
  worker.start();
  log.info("control worker started (durable OS-control queue consumer)");

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await worker.stop();
    closeDb();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
}

main().catch((error) => {
  log.error({ err: error }, "control worker failed");
  process.exit(1);
});
