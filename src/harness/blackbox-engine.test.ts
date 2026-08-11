/**
 * harness blackbox の gate 判定まわり — 許可リスト特徴量とシード再投入 (upsert) の裏取り。
 * vitest は registry 共有 (isolate:false) でモックが効かないため、 実 DB + 注入で書く。
 */
import { describe, it, expect } from "vitest";
import { makeSqliteBlackBox } from "@ludiars/blackbox";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createHarnessBlackbox, HARNESS_BLACKBOX_DOMAINS } from "./blackbox-engine.js";
import { withMainPushAllowlist, type HarnessAction } from "./predicates.js";
import { evaluateAction } from "./session-gate.js";

const GATE = HARNESS_BLACKBOX_DOMAINS.gate;
const ALLOWLIST = ["KuzuSurvivors", "MakaiNui"];

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
  command: "git -C C:/repos/KuzuSurvivors push origin main",
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
      command: "git -C C:/repos/KuzuSurvivors status && git push origin main",
    };
    const { verdict } = await decide(service, action, ALLOWLIST);
    expect(verdict.decision).toBe("deny");
    expect(verdict.hits.map((h) => h.rule)).toContain("no-main-push");
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
