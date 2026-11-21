import type { InstructionAgent } from "../agent-instructions/instruction-policy.js";
import type { InstructionService } from "../agent-instructions/instruction-service.js";
import { decideMergeReturn, mergeReturnKey, type MergeReturnTarget } from "./merge-return-policy.js";
import type { MergeReturnRepository, MergeReturnStatus } from "./merge-return-repository.js";
import type { ConfluxRequests } from "./requests.js";

export interface MergeReturnConfig {
  platforms: string[];
  agent: InstructionAgent;
}

export class MergeReturnService {
  constructor(private readonly repo: MergeReturnRepository, private readonly deps: {
    settings: (project: string) => MergeReturnConfig | undefined;
    breaker: () => { status: "OPEN" | "CLOSED"; reason: string | null };
    requests: Pick<ConfluxRequests, "buildForMerge">;
    instructions: Pick<InstructionService, "register">;
    now?: () => number;
  }) {}

  observe(observationKey: string, target: MergeReturnTarget): MergeReturnStatus | null {
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
      const build = this.deps.requests.buildForMerge({ ...target, dedupe_key: dedupeKey, platforms: settings.platforms });
      if ("error" in build) {
        this.repo.insert({ ...base, status: "build_rejected", reason: build.error });
        return "build_rejected";
      }
      const instruction = this.deps.instructions.register({
        agent: settings.agent,
        type: "playtest",
        title: `${target.project_code} マージ後の再試遊`,
        body: `マージされたコミット ${target.merge_commit_sha} を再試遊し、結果を報告してください。試遊に新しいビルドが必要な場合は、ビルド結果を確認してから実行してください。`,
        params: { ...target, dedupe_key: dedupeKey },
      });
      this.repo.insert({ ...base, status: "queued", reason: null, build_key: dedupeKey, instruction_id: instruction.id });
      return "queued";
    });
  }
}
