/**
 * harness blackbox の gate 判定まわり — 許可リスト特徴量とシード再投入 (upsert) の裏取り。
 * vitest は registry 共有 (isolate:false) でモックが効かないため、 実 DB + 注入で書く。
 */
import { describe, it, expect } from "vitest";
import { makeSqliteBlackBox } from "@ludiars/blackbox";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createHarnessBlackbox, HARNESS_BLACKBOX_DOMAINS, resolveGateVerdict } from "./blackbox-engine.js";
import { withMainPushAllowlist, type HarnessAction } from "./predicates.js";
import { evaluateAction } from "./session-gate.js";

const GATE = HARNESS_BLACKBOX_DOMAINS.gate;
const ALLOWLIST = ["AlphaGame", "BetaGame"];

/** 旧版 (許可リスト以前) の no-main-push シードを直接投入する。 */
function seedLegacyNoMainPush(db: ReturnType<typeof makeTestDb>): string {
  const box = makeSqliteBlackBox(db, { reviewLlmDecisions: false });
  const rule = box.engine.addRule({
    domain: GATE,
    description: "Block direct pushes to main/master from local session hooks.",
    when: { op: "cmp", feature: "command_pushes_main", cmp: "==", value: true },
    output: {
      decision: "deny",
      hits: [{ rule: "no-main-push", decision: "deny", reason: "legacy", suggestion: "legacy" }],
      blocked: true,
      reason: "[no-main-push] legacy",
    },
    confidence: 0.99,
    state: "auto",
    source: "seed",
    priority: 300,
  });
  return rule.id;
}

function decide(service: ReturnType<typeof createHarnessBlackbox>, action: HarnessAction, allowlist: string[]) {
  const verdict = evaluateAction(action, withMainPushAllowlist(allowlist));
  return service.decideGate({ action, editedRepos: [], verdict, mainPushAllowlist: allowlist });
}

const allowlistedPush: HarnessAction = {
  tool: "Bash",
  command: "git -C C:/repos/AlphaGame push origin main",
  cwd: "C:/repos/Concordia",
  branch: "feat/x",
};

const plainPush: HarnessAction = {
  tool: "Bash",
  command: "git push origin main",
  cwd: "C:/repos/Figmentum",
  branch: "main",
};

describe("harness blackbox gate — main push 許可リスト", () => {
  it("許可リポへの main push は deny されず allowlisted として記録される", async () => {
    const service = createHarnessBlackbox(makeTestDb());
    const { verdict } = await decide(service, allowlistedPush, ALLOWLIST);
    expect(verdict.decision).not.toBe("deny");
    expect(verdict.blocked).toBe(false);
    expect(verdict.hits.map((h) => h.rule)).toContain("main-push-allowlisted");
  });

  it("許可リストが空なら従来どおり deny", async () => {
    const service = createHarnessBlackbox(makeTestDb());
    const { verdict } = await decide(service, allowlistedPush, []);
    expect(verdict.decision).toBe("deny");
    expect(verdict.blocked).toBe(true);
    expect(verdict.hits.map((h) => h.rule)).toContain("no-main-push");
  });

  it("非許可リポは許可リスト設定下でも deny (既存挙動の維持)", async () => {
    const service = createHarnessBlackbox(makeTestDb());
    const { verdict } = await decide(service, plainPush, ALLOWLIST);
    expect(verdict.decision).toBe("deny");
    expect(verdict.hits.map((h) => h.rule)).toContain("no-main-push");
  });

  it("allowlisted な decoy -C を混ぜた複合コマンドも deny", async () => {
    const service = createHarnessBlackbox(makeTestDb());
    const action: HarnessAction = {
      ...plainPush,
      command: "git -C C:/repos/AlphaGame status && git push origin main",
    };
    const { verdict } = await decide(service, action, ALLOWLIST);
    expect(verdict.decision).toBe("deny");
    expect(verdict.hits.map((h) => h.rule)).toContain("no-main-push");
  });
});

describe("harness blackbox gate — 学習ルールの理由文", () => {
  const staleHit = {
    rule: "outside-scope",
    decision: "warn" as const,
    reason: "作業対象 (Concordia) 外のリポで編集しています (wt-uf-clio @ feat/musa-clio)",
  };

  /** 過去の別 action から学習された outside-scope ルール (保存 output に古い repo 名を含む)。 */
  function seedLearnedOutsideScope(db: ReturnType<typeof makeTestDb>): string {
    const box = makeSqliteBlackBox(db, { reviewLlmDecisions: false });
    return box.engine.addRule({
      domain: GATE,
      description: "Observed harness gate: outside-scope",
      when: {
        op: "and",
        clauses: [
          { op: "cmp", feature: "deterministic_rule", cmp: "==", value: "outside-scope" },
          { op: "cmp", feature: "deterministic_decision", cmp: "==", value: "warn" },
        ],
      },
      output: { decision: "warn", hits: [staleHit], blocked: false, reason: `[outside-scope] ${staleHit.reason}` },
      confidence: 0.9,
      state: "auto",
      source: "llm",
      priority: 40,
    }).id;
  }

  const action: HarnessAction = { tool: "Write", filePath: "E:/Document/Ars/.wt-ex-catalog/x.ts", branch: "chore/excubitor-catalog" };
  const currentHit = {
    rule: "outside-scope",
    decision: "warn" as const,
    reason: "作業対象 (Concordia) 外のリポで編集しています (.wt-ex-catalog @ chore/excubitor-catalog)",
  };
  const current = { decision: "warn" as const, hits: [currentHit], blocked: false, reason: `[outside-scope] ${currentHit.reason}` };

  it("rule 一致時も理由文と hits は今回の判定から作る (保存済みの repo 名を出さない)", async () => {
    const db = makeTestDb();
    const service = createHarnessBlackbox(db);
    const ruleId = seedLearnedOutsideScope(db);
    const { verdict, meta } = await service.decideGate({ action, editedRepos: [], verdict: current });
    expect(meta.engine_source).toBe("rule");
    expect(meta.rule_id).toBe(ruleId);
    expect(verdict.decision).toBe("warn");
    expect(verdict.reason).toBe(current.reason);
    expect(verdict.reason).not.toContain("wt-uf-clio");
    expect(verdict.hits).toEqual([currentHit]);
  });

  it("resolveGateVerdict: 今回に無い hit (シードの固定文) だけはルール側から足し、decision はルールに従う", () => {
    const ruleOutput = {
      decision: "deny",
      hits: [staleHit, { rule: "no-main-push", decision: "deny", reason: "Direct push blocked." }],
      blocked: true,
      reason: "stale",
    };
    const resolved = resolveGateVerdict(ruleOutput, current);
    expect(resolved.decision).toBe("deny");
    expect(resolved.blocked).toBe(true);
    expect(resolved.hits.map((h) => h.reason)).toEqual([currentHit.reason, "Direct push blocked."]);
    expect(resolved.reason).toBe(`${current.reason} / [no-main-push] Direct push blocked.`);
  });

  it("resolveGateVerdict: 今回の hit が無ければルールの hits と reason を使う", () => {
    const empty = { decision: "allow" as const, hits: [], blocked: false, reason: "none" };
    const ruleOutput = { decision: "warn", hits: [], blocked: false, reason: "[max-repos] too many" };
    expect(resolveGateVerdict(ruleOutput, empty)).toEqual({ decision: "warn", hits: [], blocked: false, reason: "[max-repos] too many" });
  });
});

describe("harness blackbox gate — シード upsert", () => {
  it("旧シードが入った DB でも再シードで新 when が有効になる (旧版は retired)", async () => {
    const db = makeTestDb();
    const legacyId = seedLegacyNoMainPush(db);

    const service = createHarnessBlackbox(db); // 再シード = Cc 再起動相当
    const rules = service.snapshot(GATE).rules;
    const legacy = rules.find((r) => r.id === legacyId);
    expect(legacy?.state).toBe("retired");

    const current = rules.find((r) => r.source === "seed" && r.state === "auto" && r.description.includes("allowlisted"));
    expect(current).toBeDefined();

    // 旧ルールが発火していれば allowlist に関係なく deny になる。
    const { verdict } = await decide(service, allowlistedPush, ALLOWLIST);
    expect(verdict.decision).not.toBe("deny");
  });

  it("再シードは冪等 (同じ seed を二度読んでもルールが増えない)", () => {
    const db = makeTestDb();
    const first = createHarnessBlackbox(db).snapshot(GATE).rules;
    const second = createHarnessBlackbox(db).snapshot(GATE).rules;
    expect(second).toHaveLength(first.length);
    expect(second.every((r) => r.state === "auto")).toBe(true);
  });
});
