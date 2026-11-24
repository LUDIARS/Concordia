/**
 * 定時ジョブの外部エージェント委託の結線 (spec/feature/parttimer-agent-dispatch.md)。 bootstrap から 1 回だけ呼ぶ。
 * 発火の分岐 (cron scheduler へ渡す口)・結果の引き取り (指令の出来事の subscribe)・期限切れの戻し (周期) を組み立てる。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 結線
 */

import type { InstructionEventListener } from "../agent-instructions/instruction-events.js";
import type { InstructionAgent } from "../agent-instructions/instruction-policy.js";
import type { InstructionService } from "../agent-instructions/instruction-service.js";
import type { StatusSnapshot } from "../service-status/policy.js";
import { createChildLogger } from "../shared/logger.js";
import { createAgentDispatcher, type AgentDispatchInput, type AgentDispatchOutcome } from "./agent-dispatch.js";
import { createOriginalInvoker, startAgentFallbackLoop, type OriginalInvokerDeps } from "./agent-fallback.js";
import { readAiNoteArticles } from "./agent-job-sources/ai-note-articles.js";
import { readDependencyRepos } from "./agent-job-sources/dependency-repos.js";
import { gitRead } from "./agent-job-sources/git-read.js";
import { readReviewTargets } from "./agent-job-sources/review-targets.js";
import { readServiceMap } from "./agent-job-sources/service-map.js";
import { toServiceStatusItems } from "./agent-job-sources/service-status-items.js";
import { createAgentJobRegistry } from "./agent-jobs/registry.js";
import { createAgentResultIntake } from "./agent-result-intake.js";
import type { CronJobDefinition } from "./cron-jobs.js";

export interface AgentDispatchRuntimeDeps {
  instructions: Pick<InstructionService, "registerOnce" | "record" | "listUnreceivedBefore" | "closeUnreceived" | "lastDoneSummary">;
  subscribeEvents: (listener: InstructionEventListener) => () => void;
  settings: {
    getCronJobAgent(jobName: string): InstructionAgent | null;
    getCronJobAgentFallbackMinutes(): number;
    getCronJobOverride(jobName: string): string | null;
    getGithubOrg(): string;
  };
  jobs: readonly CronJobDefinition[];
  delegation: OriginalInvokerDeps["delegation"];
  templateTitle: (callName: string) => string | null;
  workspaceRoot: () => string;
  serviceStatus: () => Promise<StatusSnapshot>;
  /** 従来の出力先 (管制チャンネル)。 送信側で allowedMentions を空にする。 */
  post: (text: string) => Promise<unknown>;
}

export interface AgentDispatchRuntime {
  dispatchToAgent: (input: AgentDispatchInput) => Promise<AgentDispatchOutcome>;
  /** 結果の引き取りと期限切れの戻しを始める。 cron scheduler と同じ寿命で止める。 */
  start: () => { stop: () => void };
}

export function createAgentDispatchRuntime(deps: AgentDispatchRuntimeDeps): AgentDispatchRuntime {
  const log = createChildLogger("cron-agent-dispatch");
  const registry = createAgentJobRegistry({
    services: async () => toServiceStatusItems(await deps.serviceStatus()),
    reviewTargets: async () => {
      const root = deps.workspaceRoot();
      return readReviewTargets({ workspaceRoot: root, repos: await readServiceMap(root), git: gitRead });
    },
    aiNoteArticles: () => readAiNoteArticles(deps.workspaceRoot()),
    dependencyRepos: async () => {
      const root = deps.workspaceRoot();
      return readDependencyRepos({ workspaceRoot: root, repos: await readServiceMap(root), githubOrg: deps.settings.getGithubOrg(), git: gitRead });
    },
    lastDoneSummary: (job) => deps.instructions.lastDoneSummary(job),
  });
  const logPort = {
    info: (detail: Record<string, unknown>, message: string) => log.info(detail, message),
    warn: (detail: Record<string, unknown>, message: string) => log.warn(detail, message),
  };
  const dispatchToAgent = createAgentDispatcher({
    resolveAgent: (jobName) => deps.settings.getCronJobAgent(jobName),
    jobs: registry,
    instructions: deps.instructions,
    templateTitle: deps.templateTitle,
    log: logPort,
  });
  const intake = createAgentResultIntake({
    paramsOf: (id) => deps.instructions.record(id)?.params ?? null,
    jobs: registry,
    post: deps.post,
  });
  const invokeOriginal = createOriginalInvoker({
    jobs: deps.jobs,
    delegation: deps.delegation,
    resolveCallNameOverride: (jobName) => deps.settings.getCronJobOverride(jobName),
  });
  return {
    dispatchToAgent,
    start: () => {
      const unsubscribe = deps.subscribeEvents(intake);
      const loop = startAgentFallbackLoop({
        instructions: deps.instructions,
        fallbackMinutes: () => deps.settings.getCronJobAgentFallbackMinutes(),
        invokeOriginal,
        post: deps.post,
        log: logPort,
      });
      return { stop: () => { loop.stop(); unsubscribe(); } };
    },
  };
}
