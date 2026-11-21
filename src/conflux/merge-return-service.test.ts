import { expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { CircuitBreakerRepository } from "../management/circuit-breaker-repo.js";
import { CircuitBreakerService } from "../management/circuit-breaker-service.js";
import { MergeReturnRepository } from "./merge-return-repository.js";
import { MergeReturnService } from "./merge-return-service.js";
import { createMergeObserver } from "./merge-observer.js";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import { ConfluxRepository } from "./repository.js";
import { ConfluxRequests } from "./requests.js";
import { startConfluxWorker } from "./worker.js";

const target = { project_code: "Cc", merge_commit_sha: "a".repeat(40), branch: "main" };

function makeFixture() {
  const db = makeTestDb();
  const buildRepo = new ConfluxRepository(db);
  const returnRepo = new MergeReturnRepository(db);
  const instructions = new InstructionService({ store: new SqliteAgentInstructionStore(db) });
  const breaker = new CircuitBreakerService(new CircuitBreakerRepository(db), {
    now: () => 1, isCostBlocked: () => false, countManagedRuns: () => 0,
    postAlert: async () => true, sessionLink: () => null,
  });
  const service = (register: InstructionService["register"] = (input) => instructions.register(input)) => new MergeReturnService(returnRepo, {
    settings: (project) => project === "Cc" ? { platforms: ["windows"], agent: "muse" } : undefined,
    breaker: () => breaker.snapshot(),
    requests: new ConfluxRequests(buildRepo, { canSpawn: () => null, launch: async () => false, canBuild: () => true }),
    instructions: { register },
  });
  return { buildRepo, returnRepo, instructions, breaker, service };
}

it("uses the confirmed merge observation without a Conflux hook and suppresses duplicate builds and instructions", async () => {
  const { buildRepo, returnRepo, instructions, service } = makeFixture();
  const mergeReturn = service();
  const head = "b".repeat(40);
  const worker = startConfluxWorker(buildRepo, {
    integrations: ["one", "two"].map((id) => ({
      prId: id, decisionId: id, projectCode: "Cc", repository: "LUDIARS/Concordia", commit: head,
    })),
    pullRequest: async (id) => ({ id, status: "merged", repository: "LUDIARS/Concordia", headSha: head,
      mergeCommitSha: target.merge_commit_sha, baseRef: target.branch }),
    onMerged: (binding, pr) => {
      mergeReturn.observe(binding.prId, { project_code: binding.projectCode, merge_commit_sha: pr.mergeCommitSha!, branch: pr.baseRef! });
      return true;
    },
    runBuild: () => Promise.reject(new Error("this tick starts before the build is queued")),
    hook: null, warn: () => {}, intervalMs: 60_000,
  });
  worker.tick();
  await expect.poll(() => returnRepo.recent().length).toBe(2);
  await worker.stop();
  const freshService = service();
  expect(freshService.observe("one", target)).toBeNull();
  expect(returnRepo.recent().map(({ status }) => status)).toEqual(["duplicate", "queued"]);
  const job = buildRepo.claimBuild();
  expect(job).toMatchObject({ commit: target.merge_commit_sha, branch: "main", platforms: ["windows"] });
  expect(buildRepo.claimBuild()).toBeUndefined();
  expect(instructions.poll("muse", "pending", 10)).toEqual([expect.objectContaining({
    type: "playtest", params: { ...target, dedupe_key: job?.dedupe_key },
  })]);
});

it("persists a breaker trip reason and disabled observations without a build or instruction", () => {
  const { buildRepo, returnRepo, instructions, breaker, service } = makeFixture();
  breaker.trip(null);
  const mergeReturn = service();
  expect(mergeReturn.observe("closed", target)).toBe("breaker_open");
  expect(mergeReturn.observe("disabled", { ...target, project_code: "Other" })).toBe("disabled");
  expect(returnRepo.recent()).toEqual([
    expect.objectContaining({ status: "disabled" }),
    expect.objectContaining({ status: "breaker_open", reason: "manual" }),
  ]);
  expect(buildRepo.claimBuild()).toBeUndefined();
  expect(instructions.poll("muse", "pending", 10)).toEqual([]);
});

it("rolls back the build receipt and retries the observation if Muse registration fails", () => {
  const { buildRepo, returnRepo, service } = makeFixture();
  expect(() => service(() => { throw new Error("could not save instruction"); }).observe("one", target)).toThrow();
  expect(returnRepo.recent()).toEqual([]);
  expect(buildRepo.claimBuild()).toBeUndefined();
  expect(service().observe("one", target)).toBe("queued");
});

it("discovers new registered project merges and does not replay older PRs after restart", async () => {
  const { returnRepo, service } = makeFixture();
  const project = { code: "Cc", repo_origin: "https://github.com/LUDIARS/Concordia.git" };
  const since = Date.UTC(2026, 10, 21);
  const fresh: RevisorLocalPr = {
    id: "new", number: 1, repository: "LUDIARS/Concordia", status: "merged", checkStatus: "test_ok",
    headSha: "b".repeat(40), mergeCommitSha: target.merge_commit_sha, baseRef: "main", headRef: "feature",
    author: "fixture", title: "Merge", createdAt: "", updatedAt: new Date(since + 1).toISOString(),
  };
  const stale = { ...fresh, id: "old", updatedAt: new Date(since - 1).toISOString() };
  const pullRequest = vi.fn(async () => fresh);
  const listMerges = vi.fn(async () => [stale, { ...fresh, baseRef: "" }]);
  const observation = (enabledAt: Map<string, number>) => createMergeObserver({
    enabledAt, repository: returnRepo, service: service(), pullRequest, listMerges, report: () => {},
    projects: { list: () => [project], findByRepoOrigin: () => project },
  });
  const signal = new AbortController().signal;
  await observation(returnRepo.syncEnabledProjects(["Cc"], since)).discover?.(signal);
  await observation(returnRepo.syncEnabledProjects(["Cc"], since + 10_000)).discover?.(signal);
  expect(listMerges.mock.calls).toEqual([[since], [since]]);
  expect(pullRequest.mock.calls).toEqual([["new"]]);
  expect(returnRepo.recent()).toEqual([expect.objectContaining({ ...target, status: "queued" })]);
});
