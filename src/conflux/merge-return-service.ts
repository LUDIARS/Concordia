import type { InstructionAgent } from "../agent-instructions/instruction-policy.js";
import type { InstructionService } from "../agent-instructions/instruction-service.js";
import { mergeReturnInstruction } from "./merge-return-instruction.js";
import { decideMergeReturn, mergeReturnKey, type MergeReturnTarget } from "./merge-return-policy.js";
import type { MergeReturnRepository, MergeReturnStatus } from "./merge-return-repository.js";
import type { ConfluxRequests } from "./requests.js";

export interface MergeReturnConfig {
  platforms: string[];
  agent: InstructionAgent;
  /** false: the agent builds the commit itself and no Conflux build is queued. */
  build: boolean;
}

export class MergeReturnService {
  constructor(private readonly repo: MergeReturnRepository, private readonly deps: {
    settings: (project: string) => MergeReturnConfig | undefined;
    breaker: () => { status: "OPEN" | "CLOSED"; reason: string | null };
    requests: Pick<ConfluxRequests, "buildForMerge">;
    instructions: Pick<InstructionService, "register">;
    now?: () => number;
  }) {}

  observe(observationKey: string, target: MergeReturnTarget, repository?: string): MergeReturnStatus | null {
    return this.repo.transaction(() => {
      if (this.repo.find(observationKey)) return null;
      const settings = this.deps.settings(target.project_code);
      const alreadyQueued = this.repo.wasQueued(target);
      const breaker = !alreadyQueued && settings ? this.deps.breaker() : { status: "CLOSED" as const, reason: null };
      const decision = decideMergeReturn(alreadyQueued, Boolean(settings), breaker);
      const base = {
        ...target, observation_key: observationKey, observed_at: (this.deps.now ?? Date.now)(),
        build_key: null, instruction_id: null,
      };
      if (decision !== "queued" || !settings) {
        this.repo.insert({ ...base, status: decision, reason: decision === "breaker_open" ? breaker.reason : null });
        return decision;
      }

      const dedupeKey = mergeReturnKey(target);
      if (settings.build) {
        const build = this.deps.requests.buildForMerge({ ...target, dedupe_key: dedupeKey, platforms: settings.platforms });
        if ("error" in build) {
          this.repo.insert({ ...base, status: "build_rejected", reason: build.error });
          return "build_rejected";
        }
      }
      const instruction = this.deps.instructions.register({
        agent: settings.agent,
        type: "playtest",
        ...mergeReturnInstruction(target, dedupeKey, settings.build, repository ?? null),
      });
      // build_key stays null for agent builds; the control API reads that as build_mode "agent".
      this.repo.insert({
        ...base, status: "queued", reason: null, build_key: settings.build ? dedupeKey : null, instruction_id: instruction.id,
      });
      return "queued";
    });
  }
}
