import type { Database } from "better-sqlite3";
import type { StaffRepo } from "../db/staff-repo.js";
import type { RevisorClient } from "../pr/revisor-client.js";
import { isConfluxLocalPeer } from "../api/conflux.js";
import { createChildLogger } from "../shared/logger.js";
import { runConfluxBuild } from "./build-runner.js";
import { readConfluxConfig } from "./config.js";
import { confluxIdentity } from "./identity.js";
import { confluxProject, createConfluxLaunch } from "./launch.js";
import { ConfluxRepository } from "./repository.js";
import { ConfluxRequests } from "./requests.js";
import { startConfluxWorker } from "./worker.js";

type LaunchDeps = Parameters<typeof createConfluxLaunch>[0];

export function createConfluxRuntime(deps: Omit<LaunchDeps, "destinations"> & {
  db: Database;
  env: NodeJS.ProcessEnv;
  staff: StaffRepo;
  revisor: Pick<RevisorClient, "getLocalPrDetail">;
  publicHost?: string;
}) {
  const log = createChildLogger("conflux-integration");
  const config = readConfluxConfig(deps.env);
  const repo = new ConfluxRepository(deps.db);
  const launch = createConfluxLaunch({ ...deps, destinations: config.destinations });
  const requestService = new ConfluxRequests(repo, {
    ...launch,
    canBuild: (code) => Object.hasOwn(config.builds, code) && confluxProject(deps.projects, code) !== null,
  });
  const worker = startConfluxWorker(repo, {
    runBuild: async (job, signal) => {
      const project = confluxProject(deps.projects, job.project_code);
      if (!project || !Object.hasOwn(config.builds, project.code)) throw new Error("Conflux build runner unavailable");
      await runConfluxBuild(project.repo_path, config.builds[project.code], job, signal);
    },
    integrations: config.integrations,
    pullRequest: (id) => deps.revisor.getLocalPrDetail(id),
    hook: config.hook,
    warn: (message) => log.warn(message),
  });
  return {
    routes: {
      requests: requestService,
      publicHost: deps.publicHost,
      isLocalPeer: isConfluxLocalPeer,
      identity: (token: string) => confluxIdentity(token, config.actors, deps.staff,
        (id) => id === "hq" || deps.subsidiaries.find(id)?.enabled === 1),
    },
    stop: worker.stop,
  };
}
