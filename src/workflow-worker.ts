/** Standalone delegation workflow queue consumer. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./shared/config.js";
import { createChildLogger } from "./shared/logger.js";
import { openDb, closeDb } from "./db/index.js";
import { SessionsRepo } from "./db/sessions-repo.js";
import { DelegationRepo } from "./db/delegation-repo.js";
import { DelegationService } from "./delegation/service.js";
import { DelegationEffortBlackbox } from "./delegation/effort-blackbox.js";
import { InjectManualsRepo } from "./db/inject-manuals-repo.js";
import { runClaude } from "./rules/claude-runner.js";
import { DelegationQueue } from "./delegation/queue.js";
import { AdminState } from "./admin/state.js";
import { makeDiscordConfigRepo } from "./db/discord-repo.js";
import { setConcordiaAddress, setLictorLauncherResolver } from "./control/spawner.js";
import { resolveLictorLauncher } from "./control/lictor-launcher.js";
import { readWorkflowWorkerLease, startWorkflowWorkerLease } from "./bootstrap/workflow.js";

const log = createChildLogger("workflow-worker");

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadDotEnv(join(process.cwd(), ".env"));
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const sessions = new SessionsRepo(db);
  const delegationRepo = new DelegationRepo(db);
  const configRepo = makeDiscordConfigRepo(db);
  const existingLease = readWorkflowWorkerLease(configRepo);
  if (existingLease && existingLease.pid !== process.pid) {
    throw new Error(`workflow-worker already active pid=${existingLease.pid}`);
  }
  const lease = startWorkflowWorkerLease(configRepo);
  const workspaceRoot = cfg.workspaceRoot || cfg.spawnDefaultCwd;
  const adminState = new AdminState(db, {
    workspaceRoot,
    workspaceRoots: cfg.workspaceRoots.length ? cfg.workspaceRoots : (workspaceRoot ? [workspaceRoot] : []),
    githubOrg: cfg.githubOrg,
    lictorDevPath: workspaceRoot ? join(workspaceRoot, "Lictor") : "",
  });
  setLictorLauncherResolver(() => resolveLictorLauncher(adminState));
  setConcordiaAddress(() => ({ host: cfg.host, port: cfg.port }));

  const concordiaUrl = `http://${cfg.host}:${cfg.port}`;
  // キュー払い出しの launch でも main プロセスと同じ kind 別マニュアルを差し込む
  // (seed は main プロセスの boot が担う。 ここは read-only)。
  const injectManualsRepo = new InjectManualsRepo(db);
  const service = new DelegationService({
    repo: delegationRepo,
    concordiaUrl,
    effortBlackbox: new DelegationEffortBlackbox(db, runClaude),
    injectManual: (kind) => injectManualsRepo.get(kind)?.content ?? null,
  });
  const queue = new DelegationQueue({
    repo: delegationRepo,
    sessions,
    resolveMaxConcurrency: () => adminState.getDelegationMaxConcurrency(),
    spawnQueued: (run) => service.spawnQueuedRun(run),
  });
  service.setQueue(queue);
  queue.start();
  await queue.drain();
  log.info("workflow worker started (delegation queue consumer)");

  const shutdown = async (): Promise<void> => {
    queue.stop();
    lease.stop();
    closeDb();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
}

main().catch((error) => {
  log.error({ err: error }, "workflow worker failed");
  process.exit(1);
});
