import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { CircuitBreakerRepository } from "../management/circuit-breaker-repo.js";
import { CircuitBreakerService } from "../management/circuit-breaker-service.js";
import { MergeReturnRepository, type MergeReturnRecord } from "./merge-return-repository.js";
import { MergeReturnService } from "./merge-return-service.js";
import { mergeReturnInstructionState, projectMergeReturn, type MergeReturnProgressLookups } from "./merge-return-progress.js";
import { ConfluxRepository } from "./repository.js";
import { ConfluxRequests } from "./requests.js";

const sha = (c: string) => c.repeat(40);

function makeFixture() {
  const db = makeTestDb();
  const buildRepo = new ConfluxRepository(db);
  const returnRepo = new MergeReturnRepository(db);
  const instructions = new InstructionService({ store: new SqliteAgentInstructionStore(db) });
  const breaker = new CircuitBreakerService(new CircuitBreakerRepository(db), {
    now: () => 1, isCostBlocked: () => false, countManagedRuns: () => 0,
    postAlert: async () => true, sessionLink: () => null,
  });
  const service = new MergeReturnService(returnRepo, {
    settings: (project) => project === "Cc" ? { platforms: ["windows"], agent: "muse", build: true }
      : project === "Ai" ? { platforms: ["mac"], agent: "muse", build: false } : undefined,
    breaker: () => breaker.snapshot(),
    requests: new ConfluxRequests(buildRepo, { canSpawn: () => null, launch: async () => false, canBuild: () => true }),
    instructions,
  });
  const lookups = (relay?: MergeReturnProgressLookups["relay"]): MergeReturnProgressLookups => ({
    buildStatus: (key) => buildRepo.buildStatus(key),
    instruction: (id) => instructions.get(id),
    relay,
  });
  const queue = (key: string, project: "Cc" | "Ai", commit: string): MergeReturnRecord => {
    expect(service.observe(key, { project_code: project, merge_commit_sha: commit, branch: "main" }, `LUDIARS/${project}`)).toBe("queued");
    return returnRepo.find(key)!;
  };
  return { instructions, lookups, queue };
}

describe("merge return progress projection", () => {
  it("keeps the queued intake and projects each linked agent-build instruction as done, failed, waiting, running or unknown", () => {
    const { instructions, lookups, queue } = makeFixture();
    const done = queue("done", "Ai", sha("1"));
    const failed = queue("failed", "Ai", sha("2"));
    const waiting = queue("waiting", "Ai", sha("3"));
    const running = queue("running", "Ai", sha("4"));
    instructions.recordResult(done.instruction_id!, { agent: "muse", status: "done", summary: "secret summary" });
    instructions.recordResult(failed.instruction_id!, { agent: "muse", status: "failed", summary: "secret failure" });
    instructions.ack(running.instruction_id!, "muse");
    const unknown = { ...queue("unknown", "Ai", sha("5")), instruction_id: "missing-instruction" };

    const views = [done, failed, waiting, running, unknown].map((record) => projectMergeReturn(record, lookups()));
    expect(views.map((v) => [v.status, v.build_mode, v.build_status, v.instruction_state])).toEqual([
      ["queued", "agent", null, "done"],
      ["queued", "agent", null, "failed"],
      ["queued", "agent", null, "waiting"],
      ["queued", "agent", null, "running"],
      ["queued", "agent", null, "unknown"],
    ]);
    expect(views[0].instruction_finished_at).toEqual(expect.any(String));
    expect(views[2].instruction_finished_at).toBeNull();
    // The projection never exposes the instruction body or result text.
    expect(JSON.stringify(views)).not.toMatch(/secret|取得・ビルド/);
  });

  it("keeps the Conflux build status apart from the instruction state", () => {
    const { instructions, lookups, queue } = makeFixture();
    const record = queue("cc", "Cc", sha("6"));
    instructions.recordResult(record.instruction_id!, { agent: "muse", status: "done", summary: "ok" });
    const view = projectMergeReturn(record, lookups());
    expect(view).toMatchObject({ status: "queued", build_mode: "conflux", build_status: "queued", instruction_state: "done" });
    expect(view.build_key).not.toBeNull();
  });

  it("adds only the relay states for finished instructions and treats lookup failures as unknown", () => {
    const { instructions, lookups, queue } = makeFixture();
    const done = queue("relayed", "Ai", sha("7"));
    const waiting = queue("pending", "Ai", sha("8"));
    instructions.recordResult(done.instruction_id!, { agent: "muse", status: "done", summary: "ok" });
    const relay = (id: string) => ({ voluptasState: "saved", announceState: "delivered", voluptasId: "v-1", error: `boom ${id}` });
    expect(projectMergeReturn(done, lookups(relay)).relay).toEqual({ voluptas_state: "saved", announce_state: "delivered" });
    expect(projectMergeReturn(waiting, lookups(relay)).relay).toBeNull();
    expect(projectMergeReturn(done, lookups(() => { throw new Error("relay down"); })).relay).toBeNull();
    expect(projectMergeReturn(done, { ...lookups(), instruction: () => { throw new Error("db"); } }).instruction_state).toBe("unknown");
  });

  it("reports no instruction state for skipped records without an instruction", () => {
    expect(mergeReturnInstructionState(null, null)).toBeNull();
    expect(mergeReturnInstructionState("x", { status: "weird", finishedAt: null })).toBe("unknown");
  });
});
