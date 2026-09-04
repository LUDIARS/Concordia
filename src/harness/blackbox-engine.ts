import {
  makeSqliteBlackBox,
  ruleFingerprint,
  type BlackBox,
  type Condition,
  type Decision,
  type DomainStats,
  type FeatureMap,
  type LlmJudgement,
  type Rule,
  type RuleDraft,
} from "@ludiars/blackbox";
import type Database from "better-sqlite3";
import { upsertSeedRules, type KeyedSeed } from "../shared/blackbox-seed-upsert.js";
import type { PromptAnalyzerSource, PromptAnalysis } from "./local-prompt-analyzer.js";
import { isMainPushAllowlisted, MAIN_PUSH_ALLOWLIST_ENV } from "./main-push-allowlist.js";
import {
  commandPushesMain,
  isEditTool,
  MAX_REPOS,
  type Decision as GateDecision,
  type HarnessAction,
  type PredicateHit,
} from "./predicates.js";
import type { PromptIntentVerdict } from "./prompt-intent.js";
import type { GateVerdict } from "./session-gate.js";

export const HARNESS_BLACKBOX_DOMAINS = {
  gate: "concordia.harness.gate",
  intent: "concordia.harness.intent",
} as const;

export type HarnessBlackboxDomain = (typeof HARNESS_BLACKBOX_DOMAINS)[keyof typeof HARNESS_BLACKBOX_DOMAINS];
export type HarnessBlackboxSource = Decision["source"];
export type HarnessBlackboxStatus = Decision["status"];

export interface HarnessBlackboxMeta {
  enabled: true;
  domain: HarnessBlackboxDomain;
  decision_id: number;
  engine_source: HarnessBlackboxSource;
  status: HarnessBlackboxStatus;
  rule_id: string | null;
  confidence: number;
  stats: DomainStats;
}

export interface HarnessBlackboxGateInput {
  action: HarnessAction;
  editedRepos: string[];
  verdict: GateVerdict;
  session_id?: string;
  hook?: string;
  /** main 直 push を許可するリポ (未指定なら例外なし)。 特徴量 main_push_allowlisted の材料。 */
  mainPushAllowlist?: readonly string[];
}

export interface HarnessBlackboxIntentInput {
  prompt: string;
  project?: string;
  branch?: string;
  source: PromptAnalyzerSource;
  verdict: PromptIntentVerdict;
  analysis: PromptAnalysis;
}

export interface HarnessBlackboxSnapshot {
  enabled: true;
  domains: typeof HARNESS_BLACKBOX_DOMAINS;
  domain: HarnessBlackboxDomain;
  stats: DomainStats;
  pending: ReturnType<BlackBox["ledger"]["listPending"]>;
  rules: Rule[];
}

const MAIN_BRANCHES = new Set(["main", "master"]);

function isMainBranch(branch?: string): boolean {
  return !!branch && MAIN_BRANCHES.has(branch.trim());
}

function branchKind(branch?: string): "main" | "topic" | "unknown" {
  if (!branch?.trim()) return "unknown";
  return isMainBranch(branch) ? "main" : "topic";
}

function commandFamily(command: string | undefined): string {
  const cmd = (command ?? "").trim().toLowerCase();
  if (!cmd) return "none";
  if (/\bgit\b[\s\S]*\bpush\b/.test(cmd)) return "git-push";
  if (/\bgit\b[\s\S]*\b(status|diff|show|log)\b/.test(cmd)) return "git-read";
  if (/\bgit\b[\s\S]*\b(commit|merge|rebase|checkout|switch|add)\b/.test(cmd)) return "git-write";
  if (/\b(rm|del|remove-item)\b/.test(cmd)) return "delete";
  return "other";
}

function eq(feature: string, value: string | number | boolean): Condition {
  return { op: "cmp", feature, cmp: "==", value };
}

function and(...clauses: Condition[]): Condition {
  return { op: "and", clauses };
}

function gateFeatures(
  action: HarnessAction,
  editedRepos: string[],
  verdict: GateVerdict,
  mainPushAllowlist: readonly string[] = [],
): FeatureMap {
  const lead = verdict.hits.find((h) => h.decision === verdict.decision) ?? verdict.hits[0];
  const pushesMain = commandPushesMain(action.command, action.branch);
  return {
    tool: action.tool,
    branch_kind: branchKind(action.branch),
    is_edit_tool: isEditTool(action.tool),
    has_command: Boolean(action.command?.trim()),
    command_family: commandFamily(action.command),
    command_pushes_main: pushesMain,
    // 許可リスト該当リポへの main 直 push。 no-main-push ルールの除外条件。
    main_push_allowlisted: pushesMain && isMainPushAllowlisted(action, mainPushAllowlist),
    edit_on_main: isEditTool(action.tool) && isMainBranch(action.branch),
    edited_repo_count: new Set(editedRepos.map((r) => r.trim()).filter(Boolean)).size,
    deterministic_decision: verdict.decision,
    deterministic_rule: lead?.rule ?? "",
  };
}

function gateHit(rule: string, decision: Exclude<GateDecision, "allow">, reason: string, suggestion: string): PredicateHit {
  return { rule, decision, reason, suggestion };
}

function gateVerdict(decision: GateDecision, hits: PredicateHit[], reason: string): GateVerdict {
  return { decision, hits, blocked: decision === "deny", reason };
}

/**
 * コード側で固定するシードルール。 `key` は再シード時の同一性キー (fingerprint は
 * when/output を変えると変わるため、 旧版を retire して差し替えるのに使う)。
 */
type SeededGateRule = KeyedSeed<RuleDraft & { domain: HarnessBlackboxDomain }>;

const SEEDED_GATE_RULES: SeededGateRule[] = [
  {
    domain: HARNESS_BLACKBOX_DOMAINS.gate,
    key: "no-main-push",
    description: "Block direct pushes to main/master from local session hooks (allowlisted repos excepted).",
    when: and(eq("command_pushes_main", true), eq("main_push_allowlisted", false)),
    output: gateVerdict(
      "deny",
      [
        gateHit(
          "no-main-push",
          "deny",
          "Direct push to main/master is blocked by the Concordia harness.",
          `Push a topic branch and merge through review (allowlist: ${MAIN_PUSH_ALLOWLIST_ENV}).`,
        ),
      ],
      "[no-main-push] Direct push to main/master is blocked by the Concordia harness.",
    ),
    confidence: 0.99,
    state: "auto",
    source: "seed",
    priority: 300,
  },
  {
    domain: HARNESS_BLACKBOX_DOMAINS.gate,
    key: "branch-before-edit",
    description: "Warn before editing files on main/master.",
    when: and(eq("is_edit_tool", true), eq("branch_kind", "main")),
    output: gateVerdict(
      "warn",
      [
        gateHit(
          "branch-before-edit",
          "warn",
          "Editing on main/master should be moved to a task branch first.",
          "Create or switch to a task branch before committing.",
        ),
      ],
      "[branch-before-edit] Editing on main/master should be moved to a task branch first.",
    ),
    confidence: 0.98,
    state: "auto",
    source: "seed",
    priority: 200,
  },
  {
    domain: HARNESS_BLACKBOX_DOMAINS.gate,
    key: "max-repos",
    description: "Warn when one session edits more repositories than the harness limit.",
    when: { op: "cmp", feature: "edited_repo_count", cmp: ">", value: MAX_REPOS },
    output: gateVerdict(
      "warn",
      [
        gateHit(
          "max-repos",
          "warn",
          `This session has edited more than ${MAX_REPOS} repositories.`,
          "Split the work or confirm the broad scope before continuing.",
        ),
      ],
      `[max-repos] This session has edited more than ${MAX_REPOS} repositories.`,
    ),
    confidence: 0.97,
    state: "auto",
    source: "seed",
    priority: 100,
  },
];

/** 既存ルールのシード同一性キー = 出力 verdict の代表 predicate 名 (無ければ空文字)。 */
function seedRuleKey(rule: Rule): string {
  const output = rule.output;
  if (!isRecord(output) || !Array.isArray(output.hits)) return "";
  const first = output.hits.find(isRecord);
  return typeof first?.rule === "string" ? first.rule : "";
}

function gateRuleProposal(features: FeatureMap, verdict: GateVerdict): Omit<RuleDraft, "domain" | "state" | "source"> | undefined {
  const lead = verdict.hits.find((h) => h.decision === verdict.decision) ?? verdict.hits[0];
  if (!lead || verdict.decision === "allow") return undefined;
  return {
    description: `Observed harness gate: ${lead.rule}`,
    when: and(eq("deterministic_rule", lead.rule), eq("deterministic_decision", verdict.decision)),
    output: sanitizeGateVerdict(verdict, verdict),
    confidence: 0.9,
    priority: verdict.decision === "deny" ? 80 : 40,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeGateVerdict(value: unknown, fallback: GateVerdict): GateVerdict {
  if (!isRecord(value)) return fallback;
  const decision = value.decision === "deny" || value.decision === "warn" || value.decision === "allow"
    ? value.decision
    : fallback.decision;
  const hits: PredicateHit[] = Array.isArray(value.hits)
    ? value.hits
        .filter(isRecord)
        .map((h): PredicateHit => ({
          rule: typeof h.rule === "string" ? h.rule : "",
          decision: h.decision === "deny" || h.decision === "warn" ? h.decision : "warn",
          reason: typeof h.reason === "string" ? h.reason : "",
          suggestion: typeof h.suggestion === "string" ? h.suggestion : undefined,
        }))
        .filter((h) => h.rule)
    : fallback.hits;
  return {
    decision,
    hits,
    blocked: decision === "deny",
    reason: typeof value.reason === "string" ? value.reason : fallback.reason,
  };
}

function safetyScore(level: PromptAnalysis["safety"]["level"]): number {
  if (level === "danger") return 2;
  if (level === "caution") return 1;
  return 0;
}

function riskScore(risk: PromptIntentVerdict["risk"]): number {
  if (risk === "high") return 2;
  if (risk === "medium") return 1;
  return 0;
}

function intentFeatures(input: HarnessBlackboxIntentInput): FeatureMap {
  return {
    project: input.project?.trim() || "",
    branch_kind: branchKind(input.branch),
    analyzer_source: input.source,
    safety_level: input.analysis.safety.level,
    safety_score: safetyScore(input.analysis.safety.level),
    risk: input.verdict.risk,
    risk_score: riskScore(input.verdict.risk),
    decision: input.verdict.decision,
    concern_count: input.verdict.concerns.length,
    target_service_count: input.analysis.target_services.length,
    tag_count: input.analysis.search_tags.length,
    prompt_length: input.prompt.length,
  };
}

function sanitizeIntentVerdict(value: unknown, fallback: PromptIntentVerdict): PromptIntentVerdict {
  if (!isRecord(value)) return fallback;
  return {
    decision: value.decision === "warn" ? "warn" : value.decision === "allow" ? "allow" : fallback.decision,
    risk: value.risk === "high" || value.risk === "medium" || value.risk === "low" ? value.risk : fallback.risk,
    intent: typeof value.intent === "string" ? value.intent.slice(0, 240) : fallback.intent,
    concerns: Array.isArray(value.concerns)
      ? value.concerns.filter((v): v is string => typeof v === "string").slice(0, 8)
      : fallback.concerns,
    advice: typeof value.advice === "string" ? value.advice.slice(0, 500) : fallback.advice,
  };
}

function intentRuleProposal(
  input: HarnessBlackboxIntentInput,
): Omit<RuleDraft, "domain" | "state" | "source"> | undefined {
  if (input.verdict.decision !== "warn") return undefined;
  const condition = input.analysis.safety.level === "safe"
    ? and(eq("decision", "warn"), { op: "cmp", feature: "concern_count", cmp: ">", value: 0 })
    : eq("safety_level", input.analysis.safety.level);
  return {
    description: `Observed prompt warning: ${input.analysis.safety.level}/${input.verdict.risk}`,
    when: condition,
    output: sanitizeIntentVerdict(input.verdict, input.verdict),
    confidence: input.verdict.risk === "high" ? 0.86 : 0.76,
    priority: input.verdict.risk === "high" ? 60 : 30,
  };
}

export class HarnessBlackboxService {
  private readonly domains = HARNESS_BLACKBOX_DOMAINS;

  constructor(private readonly box: BlackBox) {
    this.seedGateRules();
  }

  static sqlite(db: Database.Database): HarnessBlackboxService {
    return new HarnessBlackboxService(makeSqliteBlackBox(db, { reviewLlmDecisions: false }));
  }

  async decideGate(input: HarnessBlackboxGateInput): Promise<{ verdict: GateVerdict; meta: HarnessBlackboxMeta }> {
    const domain = this.domains.gate;
    const features = gateFeatures(input.action, input.editedRepos, input.verdict, input.mainPushAllowlist ?? []);
    const llmFallback = async (): Promise<LlmJudgement<GateVerdict>> => ({
      output: sanitizeGateVerdict(input.verdict, input.verdict),
      confidence: input.verdict.decision === "allow" ? 0.72 : 0.92,
      rationale: "Concordia deterministic harness predicates",
      proposedRule: gateRuleProposal(features, input.verdict),
    });
    const { decision, decisionId } = await this.box.engine.decide(
      domain,
      {
        action: {
          tool: input.action.tool,
          command: input.action.command?.slice(0, 500) ?? "",
          filePath: input.action.filePath ?? "",
          cwd: input.action.cwd ?? "",
          project: input.action.project ?? "",
          branch: input.action.branch ?? "",
        },
        session_id: input.session_id ?? "",
        hook: input.hook ?? "",
      },
      features,
      llmFallback,
    );
    return {
      verdict: sanitizeGateVerdict(decision.output, input.verdict),
      meta: this.meta(domain, decision, decisionId),
    };
  }

  async decideIntent(input: HarnessBlackboxIntentInput): Promise<{ verdict: PromptIntentVerdict; meta: HarnessBlackboxMeta }> {
    const domain = this.domains.intent;
    const features = intentFeatures(input);
    const llmFallback = async (): Promise<LlmJudgement<PromptIntentVerdict>> => ({
      output: sanitizeIntentVerdict(input.verdict, input.verdict),
      confidence: input.verdict.decision === "warn" ? 0.82 : 0.68,
      rationale: `${input.source} prompt analyzer`,
      proposedRule: intentRuleProposal(input),
    });
    const { decision, decisionId } = await this.box.engine.decide(
      domain,
      {
        prompt_preview: input.prompt.slice(0, 200),
        project: input.project ?? "",
        branch: input.branch ?? "",
        source: input.source,
      },
      features,
      llmFallback,
    );
    return {
      verdict: sanitizeIntentVerdict(decision.output, input.verdict),
      meta: this.meta(domain, decision, decisionId),
    };
  }

  snapshot(domain: HarnessBlackboxDomain = this.domains.gate, limit = 50): HarnessBlackboxSnapshot {
    const safeLimit = Math.max(1, Math.min(200, limit));
    return {
      enabled: true,
      domains: this.domains,
      domain,
      stats: this.box.stats(domain, safeLimit),
      pending: this.box.ledger.listPending(domain, safeLimit),
      rules: this.box.engine.listRules(domain),
    };
  }

  recordVerdict(decisionId: number, verdict: "ok" | "ng"): ReturnType<BlackBox["engine"]["recordVerdict"]> {
    return this.box.engine.recordVerdict(decisionId, verdict);
  }

  private meta(domain: HarnessBlackboxDomain, decision: Decision, decisionId: number): HarnessBlackboxMeta {
    return {
      enabled: true,
      domain,
      decision_id: decisionId,
      engine_source: decision.source,
      status: decision.status,
      rule_id: decision.ruleId ?? null,
      confidence: decision.confidence,
      stats: this.box.stats(domain, 50),
    };
  }

  private seedGateRules(): void {
    upsertSeedRules({ box: this.box, keyOf: seedRuleKey }, SEEDED_GATE_RULES);
  }

}

export function createHarnessBlackbox(db: Database.Database): HarnessBlackboxService {
  return HarnessBlackboxService.sqlite(db);
}
