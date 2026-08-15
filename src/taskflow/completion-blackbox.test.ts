/**
 * completion blackbox のシード再投入 (upsert) の裏取り。
 * vitest は registry 共有 (isolate:false) でモックが効かないため、 実 DB + 注入で書く。
 */
import { describe, it, expect } from "vitest";
import { makeSqliteBlackBox } from "@ludiars/blackbox";
import { makeTestDb } from "../../tests/helpers/db.js";
import { CompletionBlackbox, COMPLETION_DOMAIN } from "./completion-blackbox.js";

type Db = ReturnType<typeof makeTestDb>;

function rules(db: Db) {
  return makeSqliteBlackBox(db, { reviewLlmDecisions: false }).engine.listRules(COMPLETION_DOMAIN);
}

/**
 * 旧版の "completed" シードを直接投入する。
 * 現行は `pr_state == "merged"` だが、 旧版は `pr_state == "closed"` でも完了扱いだった、 という想定。
 */
function seedLegacyCompleted(db: Db): string {
  const box = makeSqliteBlackBox(db, { reviewLlmDecisions: false });
  const rule = box.engine.addRule({
    domain: COMPLETION_DOMAIN,
    description: "legacy: any closed PR completes implementation.",
    when: { op: "cmp", feature: "pr_state", cmp: "==", value: "closed" },
    output: "completed",
    confidence: 0.99,
    state: "auto",
    source: "seed",
    priority: 200,
  });
  return rule.id;
}

const decideInput = (prState: string) => ({
  sessionId: "s1",
  prState,
  hasPushOrCommit: true,
  hasDiff: true,
  finalText: "実装しました",
  reportBullets: 2,
});

describe("CompletionBlackbox — シード upsert", () => {
  it("旧シードが入った DB でも再シードで新 when が有効になる (旧版は retired)", async () => {
    const db = makeTestDb();
    const legacyId = seedLegacyCompleted(db);

    const box = new CompletionBlackbox(db); // 再シード = Cc 再起動相当

    const legacy = rules(db).find((r) => r.id === legacyId);
    expect(legacy?.state).toBe("retired");

    // 現行シードは auto で入っている。
    const current = rules(db).find(
      (r) => r.source === "seed" && r.state === "auto" && r.output === "completed",
    );
    expect(current).toBeDefined();

    // 旧ルールが発火していれば closed でも completed になってしまう。
    const closed = await box.decide(decideInput("closed"));
    expect(closed.verdict).not.toBe("completed");

    // 現行ルールは効いている。
    const merged = await box.decide(decideInput("merged"));
    expect(merged.verdict).toBe("completed");
  });

  it("撤回・降格された現行シードは再シードで auto へ戻る", () => {
    const db = makeTestDb();
    new CompletionBlackbox(db);

    const box = makeSqliteBlackBox(db, { reviewLlmDecisions: false });
    const seeded = box.engine.listRules(COMPLETION_DOMAIN).filter((r) => r.source === "seed");
    expect(seeded.length).toBeGreaterThan(0);
    for (const rule of seeded) box.engine.setRuleState(rule.id, "retired");

    new CompletionBlackbox(db);

    const after = rules(db).filter((r) => r.source === "seed");
    expect(after).toHaveLength(seeded.length);
    expect(after.every((r) => r.state === "auto")).toBe(true);
  });

  it("再シードは冪等 (同じ seed を二度読んでもルールが増えない)", () => {
    const db = makeTestDb();
    new CompletionBlackbox(db);
    const first = rules(db);
    new CompletionBlackbox(db);
    const second = rules(db);

    expect(second).toHaveLength(first.length);
    expect(second.every((r) => r.state === "auto")).toBe(true);
  });
});
