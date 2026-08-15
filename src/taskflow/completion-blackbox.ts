import { makeSqliteBlackBox, type BlackBox, type Rule } from "@ludiars/blackbox";
import type Database from "better-sqlite3";
import { upsertSeedRules, type KeyedSeed } from "../shared/blackbox-seed-upsert.js";

export const COMPLETION_DOMAIN = "concordia.workflow.completion";
export type CompletionVerdict = "completed" | "not-implementation" | "unknown";

/**
 * completion ドメインのシード同一性キー = ルールの出力 verdict。
 *
 * 1 verdict につきシードは 1 本という前提なので、 `when` を書き換えても
 * 「同じ verdict を出す旧シード」 として旧版を特定できる。
 */
function seedRuleKey(rule: Rule): string {
  return typeof rule.output === "string" ? rule.output : "";
}

const seeds: KeyedSeed[] = [
  {
    domain: COMPLETION_DOMAIN,
    key: "completed",
    description: "A merged linked PR deterministically completes implementation.",
    when: { op: "cmp", feature: "pr_state", cmp: "==", value: "merged" },
    output: "completed",
    confidence: 0.99,
    state: "auto",
    source: "seed",
    priority: 200,
  },
  {
    domain: COMPLETION_DOMAIN,
    key: "not-implementation",
    description: "No push, commit, or diff means the final answer is not an implementation completion.",
    when: { op: "and", clauses: [
      { op: "cmp", feature: "has_push_or_commit", cmp: "==", value: false },
      { op: "cmp", feature: "has_diff", cmp: "==", value: false },
    ] },
    output: "not-implementation",
    confidence: 0.97,
    state: "auto",
    source: "seed",
    priority: 100,
  },
];

export class CompletionBlackbox {
  private readonly box: BlackBox;
  constructor(db: Database.Database) {
    this.box = makeSqliteBlackBox(db, { reviewLlmDecisions: false });
    // insert-once ではなく upsert。 when/output を書き換えたときに旧シードを retire
    // しないと、 既存 DB では旧ルールが auto のまま発火し続ける。
    upsertSeedRules({ box: this.box, keyOf: seedRuleKey }, seeds);
  }

  async decide(input: { sessionId: string; prState: string; hasPushOrCommit: boolean; hasDiff: boolean; finalText: string; reportBullets: number }): Promise<{ verdict: CompletionVerdict; decisionId: number }> {
    const features = {
      pr_state: input.prState,
      has_push_or_commit: input.hasPushOrCommit,
      has_diff: input.hasDiff,
      final_length: input.finalText.length,
      completion_keyword: /完了|実装|commit|pull request|PR/i.test(input.finalText),
      report_bullets: input.reportBullets,
    };
    const result = await this.box.engine.decide(
      COMPLETION_DOMAIN,
      { session_id: input.sessionId, final_preview: input.finalText.slice(0, 300) },
      features,
      async () => ({ output: "unknown", confidence: 0.4, rationale: "semantic completion requires blackbox review" }),
    );
    const output = result.decision.output;
    const verdict: CompletionVerdict = output === "completed" || output === "not-implementation" ? output : "unknown";
    return { verdict, decisionId: result.decisionId };
  }

  recordVerdict(decisionId: number, verdict: "ok" | "ng") {
    return this.box.engine.recordVerdict(decisionId, verdict);
  }
}
