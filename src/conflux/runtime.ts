import type { Database } from "better-sqlite3";
import type { StaffRepo } from "../db/staff-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { RevisorClient } from "../pr/revisor-client.js";
import { isConfluxLocalPeer } from "../api/conflux.js";
import type { InstructionService } from "../agent-instructions/instruction-service.js";
import { createChildLogger } from "../shared/logger.js";
import { runConfluxBuild } from "./build-runner.js";
import { readConfluxConfig } from "./config.js";
import { confluxIdentity } from "./identity.js";
import { confluxProject, createConfluxLaunch } from "./launch.js";
import { createMergeObserver } from "./merge-observer.js";
import { MergeReturnRepository, mergeReturnBuildMode } from "./merge-return-repository.js";
import { MergeReturnService } from "./merge-return-service.js";
import { ConfluxRepository } from "./repository.js";
import { ConfluxRequests } from "./requests.js";
import { startConfluxWorker } from "./worker.js";

type LaunchDeps = Parameters<typeof createConfluxLaunch>[0];

export function createConfluxRuntime(deps: Omit<LaunchDeps, "destinations"> & {
  db: Database;
  env: NodeJS.ProcessEnv;
  staff: StaffRepo;
  revisor: Pick<RevisorClient, "getLocalPrDetail" | "listMergedLocalPrFactsSince">;
  projects: Pick<ProjectCodesRepo, "findByCode" | "findByRepoOrigin" | "list">;
  breaker: () => { status: "OPEN" | "CLOSED"; reason: string | null };
  instructions: Pick<InstructionService, "register">;
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
  const mergeReturnRepo = new MergeReturnRepository(deps.db);
  const mergeReturns = new MergeReturnService(mergeReturnRepo, {
    settings: (code) => {
      if (!Object.hasOwn(config.mergeReturns, code)) return undefined;
      const { platforms, agent = "muse", build = true } = config.mergeReturns[code];
      return { platforms, agent, build };
    },
    breaker: deps.breaker,
    requests: requestService,
    instructions: deps.instructions,
  });
  const pullRequest = (id: string) => deps.revisor.getLocalPrDetail(id);
  const mergeObserver = createMergeObserver({
    enabledAt: mergeReturnRepo.syncEnabledProjects(Object.keys(config.mergeReturns), Date.now()),
    repository: mergeReturnRepo,
    service: mergeReturns,
    projects: deps.projects,
    pullRequest,
    listMerges: (since) => deps.revisor.listMergedLocalPrFactsSince(since),
    report: (message) => log.info(message),
  });
  const worker = startConfluxWorker(repo, {
    runBuild: async (job, signal) => {
      const project = confluxProject(deps.projects, job.project_code);
      if (!project || !Object.hasOwn(config.builds, project.code)) throw new Error("Conflux build runner unavailable");
      await runConfluxBuild(project.repo_path, config.builds[project.code], job, signal);
    },
    integrations: config.integrations,
    pullRequest,
    onMerged: (_binding, pr) => mergeObserver.observe(pr),
    discoverMerges: mergeObserver.discover,
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
    hookEvidence: () => ({ configured: config.hook !== null, ...repo.hookEvidence() }),
    recentMergeReturns: () => mergeReturnRepo.recent().map((record) => ({
      ...record,
      build_mode: mergeReturnBuildMode(record),
      build_status: record.build_key ? repo.buildStatus(record.build_key) : null,
    })),
    stop: worker.stop,
  };
}
