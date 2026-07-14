import { makeSqliteBlackBox, type BlackBox, type Condition, type DomainStats } from "@ludiars/blackbox";
import type Database from "better-sqlite3";
import type { DelegationProvider } from "../db/delegation-repo.js";
import { extractJson, type RunClaudeFn } from "../rules/claude-runner.js";
import {
  baselineEffort,
  classifyEffortTask,
  normalizeAutomaticEffort,
  type AutoEffortLevel,
  type EffortTaskBucket,
} from "./effort-policy.js";

export const DELEGATION_EFFORT_DOMAIN = "concordia.delegation.effort";

export interface DelegationEffortDecision {
  level: AutoEffortLevel;
  bucket: EffortTaskBucket;
  source: "blackbox-rule" | "blackbox-llm" | "blackbox-fallback";
  decision_id: number;
  confidence: number;
}

export class DelegationEffortBlackbox {
  private readonly box: BlackBox;

  constructor(db: Database.Database, private readonly runClaude: RunClaudeFn) {
    this.box = makeSqliteBlackBox(db, { reviewLlmDecisions: false });
  }

  async decide(input: {
    provider: DelegationProvider;
    model: string | null;
    prompt: string;
    callName: string;
    project: string | null;
  }): Promise<DelegationEffortDecision> {
    const bucket = classifyEffortTask(input.prompt);
    const model = input.model?.trim() || "(provider-default)";
    const project = input.project?.trim() || "(none)";
    const features = {
      provider: input.provider,
      model,
      task_bucket: bucket,
      call_name: input.callName,
      project,
      prompt_length: input.prompt.length,
    };
    let usedFallback = false;
    const { decision, decisionId } = await this.box.engine.decide(
      DELEGATION_EFFORT_DOMAIN,
      {
        call_name: input.callName,
        project: input.project ?? "",
        prompt_preview: input.prompt.slice(0, 500),
      },
      features,
      async (_raw, _features, context) => {
        const fallback = baselineEffort(bucket);
        const result = await this.runClaude(buildEffortPrompt({ ...input, bucket, model }, context.retiredRules), {
          model: "haiku",
          timeoutMs: 30_000,
        });
        const parsed = result.ok ? parseEffortJudgement(result.stdout) : null;
        if (!parsed) {
          usedFallback = true;
          return {
            output: fallback,
            confidence: 0.45,
            rationale: result.ok ? "invalid effort judgement; deterministic fallback" : "effort judge unavailable; deterministic fallback",
          };
        }
        return {
          output: parsed.level,
          confidence: parsed.confidence,
          rationale: parsed.rationale,
          proposedRule: {
            description: `Use ${parsed.level} for ${input.provider}/${model}/${bucket} delegation tasks.`,
            when: exactContextCondition(input.provider, model, bucket, input.callName, project),
            output: parsed.level,
            confidence: parsed.confidence,
            priority: bucket === "complex" ? 80 : bucket === "implementation" ? 60 : 40,
          },
        };
      },
    );
    return {
      level: normalizeAutomaticEffort(decision.output) ?? baselineEffort(bucket),
      bucket,
      source: decision.source === "rule" ? "blackbox-rule" : usedFallback ? "blackbox-fallback" : "blackbox-llm",
      decision_id: decisionId,
      confidence: decision.confidence,
    };
  }

  recordOutcome(decisionId: number, outcome: "completed" | "failed") {
    return this.box.engine.recordVerdict(decisionId, outcome === "completed" ? "ok" : "ng");
  }

  stats(window = 100): DomainStats {
    return this.box.stats(DELEGATION_EFFORT_DOMAIN, window);
  }
}

function exactContextCondition(
  provider: DelegationProvider,
  model: string,
  bucket: EffortTaskBucket,
  callName: string,
  project: string,
): Condition {
  return {
    op: "and",
    clauses: [
      { op: "cmp", feature: "provider", cmp: "==", value: provider },
      { op: "cmp", feature: "model", cmp: "==", value: model },
      { op: "cmp", feature: "task_bucket", cmp: "==", value: bucket },
      { op: "cmp", feature: "call_name", cmp: "==", value: callName },
      { op: "cmp", feature: "project", cmp: "==", value: project },
    ],
  };
}

function buildEffortPrompt(
  input: {
    provider: DelegationProvider;
    model: string;
    prompt: string;
    callName: string;
    project: string | null;
    bucket: EffortTaskBucket;
  },
  retiredRules: Array<{ description: string; whenText: string }>,
): string {
  const retired = retiredRules.length === 0
    ? "(none)"
    : retiredRules.map((rule) => `- ${rule.description}: ${rule.whenText}`).join("\n");
  return [
    "Choose the reasoning effort for one coding-agent delegation.",
    "Return JSON only: {\"effort\":\"low|medium|high|xhigh\",\"confidence\":0.0,\"rationale\":\"short reason\"}.",
    "Use low for routine/local work, medium for normal implementation, high for uncertain multi-file work, and xhigh for architecture, migration, security, or difficult root-cause work.",
    `provider: ${input.provider}`,
    `model: ${input.model}`,
    `task_bucket: ${input.bucket}`,
    `call_name: ${input.callName}`,
    `project: ${input.project ?? "(none)"}`,
    "Retired rules that must not be repeated:",
    retired,
    "Task prompt:",
    input.prompt,
  ].join("\n\n");
}

function parseEffortJudgement(text: string): {
  level: AutoEffortLevel;
  confidence: number;
  rationale: string;
} | null {
  const value = extractJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const level = normalizeAutomaticEffort(record.effort);
  if (!level) return null;
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : 0.7;
  return {
    level,
    confidence,
    rationale: typeof record.rationale === "string" ? record.rationale.slice(0, 500) : "LLM effort judgement",
  };
}
