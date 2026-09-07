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
import { SqliteSettingsStore } from "./admin/settings-store.js";
import { readFederationEnv } from "./federation/env.js";
import { resolveFederationSiteId } from "./federation/listener-settings.js";
import { makeDiscordConfigRepo } from "./db/discord-repo.js";
import { setConcordiaAddress, setLictorLauncherResolver, setWorkspaceRootsResolver } from "./control/spawner.js";
import { resolveLictorLauncher } from "./control/lictor-launcher.js";
import { readWorkflowWorkerLease, startWorkflowWorkerLease } from "./bootstrap/workflow.js";
import { loadSecretBox } from "./shared/secret-box.js";

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
  const federationSettings = new SqliteSettingsStore(db);
  const configRepo = makeDiscordConfigRepo(db);
  const secretBox = loadSecretBox({
    envValue: process.env.CONCORDIA_SECRET_KEY,
    keyFile: join(process.cwd(), "concordia.secret.key"),
  });
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
    reaperSessionEndGraceSec: cfg.reaperSessionEndGraceSec,
  }, secretBox);
  setLictorLauncherResolver(() => resolveLictorLauncher(adminState));
  setConcordiaAddress(() => ({ host: cfg.host, port: cfg.port }));
  setWorkspaceRootsResolver(() => adminState.getWorkspaceRoots());

  const concordiaUrl = `http://${cfg.host}:${cfg.port}`;
  // キュー払い出しの launch でも main プロセスと同じ kind 別マニュアルを差し込む
  // (seed は main プロセスの boot が担う。 ここは read-only)。
  const injectManualsRepo = new InjectManualsRepo(db);
  const service = new DelegationService({
    repo: delegationRepo,
    concordiaUrl,
    siteId: () => resolveFederationSiteId(
      federationSettings,
      readFederationEnv(process.env, { deferListenerPortValidation: true }),
    ),
    effortBlackbox: new DelegationEffortBlackbox(db, runClaude),
    injectManual: (kind) => injectManualsRepo.get(kind)?.content ?? null,
  });
  const queue = new DelegationQueue({
    repo: delegationRepo,
    sessions,
    resolveMaxConcurrency: () => adminState.getDelegationMaxConcurrency(),
    spawnQueued: (run) => service.spawnQueuedRun(run),
    keepAlive: true,
  });
  service.setQueue(queue);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        await queue.stopAndDrain();
      } finally {
        lease.stop();
        closeDb();
      }
    })();
    return shutdownPromise;
  };
  let exitRequested = false;
  const requestExit = (code: number): void => {
    if (exitRequested) return;
    exitRequested = true;
    void shutdown()
      .catch((error) => log.error({ err: error }, "workflow worker shutdown failed"))
      .finally(() => process.exit(code));
  };
  const exitAfterLeaseLoss = (reason: string): void => {
    log.error({ reason }, "workflow worker lease lost; stopping consumer");
    requestExit(1);
  };
  void lease.lost.then(exitAfterLeaseLoss);
  process.once("SIGINT", () => requestExit(0));
  process.once("SIGTERM", () => requestExit(0));
  if (!lease.owns()) {
    await shutdown();
    throw new Error("workflow worker lease lost during initialization");
  }
  queue.start();
  await queue.drain();
  if (exitRequested) return;
  log.info("workflow worker started (delegation queue consumer)");
}

main().catch((error) => {
  log.error({ err: error }, "workflow worker failed");
  process.exit(1);
});
