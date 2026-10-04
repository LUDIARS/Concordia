import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { HarnessRulesRepo } from "../src/db/harness-rules-repo.js";
import { SubsidiaryRepo, type SubsidiaryRow } from "../src/db/subsidiary-repo.js";
import { createPersonalBudget, type PersonalBudgetServices } from "../src/personal-budget/composition.js";
import { localMonth } from "../src/personal-budget/types.js";
import { processSubsidiaryRequest, type SubsidiaryGateDeps } from "../src/subsidiary/gate.js";
import { seedHarnessRules } from "../src/subsidiary/harness-seed.js";

// 子会社ゲートと個人の AI 予算の結合 (spec/feature/personal-ai-budget.md §3)。
// 月間分の上限が 0 (既定) の個人では、 port を配線しても払い出しの動きが変わらないことを固定する。

const ALLOW = '{"decision":"allow","reason":"ok","matched_call_name":"fix-content","violations":[],"lock_user":false}';
const OVER = { todayTokens: 120_000, budget: 100_000, blocked: true, dateIso: "2026-10-02" };
const UNDER = { todayTokens: 10_000, budget: 100_000, blocked: false, dateIso: "2026-10-02" };

let subRepo: SubsidiaryRepo;
let sub: SubsidiaryRow;
let budget: PersonalBudgetServices;
let globalOver: boolean;
let base: Omit<SubsidiaryGateDeps, "budget" | "personalBudget">;
let invoke: ReturnType<typeof vi.fn>;
let runClaude: ReturnType<typeof vi.fn>;

const request = () => ({ subsidiary: sub, platform: "discord" as const, userId: "111", userLabel: "alice", instruction: "README誤字直して" });

function gate(subsidiaryBudget: typeof OVER, withPersonalBudget: boolean): SubsidiaryGateDeps {
  return {
    ...base,
    budget: { status: async () => subsidiaryBudget },
    ...(withPersonalBudget ? { personalBudget: budget.dispatch } : {}),
  };
}

function person() {
  return budget.people.ensure({ subsidiaryId: sub.id, platform: "discord", platformUserId: "111" });
}

function useMonthly(tokens: number): void {
  budget.usage.applyConsumption({
    sessionId: "seed", personId: person().id, period: localMonth(Date.now()), total: tokens,
    plan: () => ({ delta: tokens, baseline: 0, monthly: tokens, reward: 0 }),
  });
}

beforeEach(() => {
  const db = makeTestDb();
  subRepo = new SubsidiaryRepo(db);
  const harnessRepo = new HarnessRulesRepo(db);
  const delegationRepo = new DelegationRepo(db);
  seedHarnessRules(harnessRepo);
  delegationRepo.createTemplate({
    call_name: "fix-content", title: "誤字修正", description: "", target_provider: "claude", prompt_template: "",
  });
  sub = subRepo.create({
    name: "testco", display_name: "TestCo", platform: "discord", enabled: true,
    guild_id: "g1", channel_id: "intake", guard_scope: "誤字修正のみ",
  });
  subRepo.upsertDelegation(sub.id, {
    call_name: "fix-content", is_default: true, title: "誤字修正",
    target_provider: "claude", prompt_template: "", default_cwd: "E:/Document/Ars/Pictor", project: "Pictor",
  });
  subRepo.setProjects(sub.id, ["Pictor"]);
  globalOver = false;
  budget = createPersonalBudget({
    db,
    subsidiaryMonthlyDefault: (id) => subRepo.find(id)?.personal_monthly_token_budget ?? null,
    isGlobalOver: () => globalOver,
    readSetting: () => null,
  });
  invoke = vi.fn(async () => ({
    ok: true as const, run: { id: "run-1" }, prompt_file_path: "", rendered_prompt: "", spawn_pid: 1, spawn_command: [],
  }));
  runClaude = vi.fn(async () => ({ ok: true, stdout: ALLOW, stderr: "" }));
  base = {
    subsidiaryRepo: subRepo,
    harnessRepo,
    delegationRepo,
    delegationService: { invokeDefinition: invoke } as unknown as SubsidiaryGateDeps["delegationService"],
    runClaude: runClaude as unknown as SubsidiaryGateDeps["runClaude"],
  };
});

describe("月間分の上限が 0 (既定) の個人 — 払い出しの動きは導入前と同じ", () => {
  it("子会社の日次 budget 内なら、 port の有無に関わらず通す (全体が超過していても従来どおり)", async () => {
    const before = await processSubsidiaryRequest(gate(UNDER, false), request());
    globalOver = true;
    const after = await processSubsidiaryRequest(gate(UNDER, true), request());
    expect(before.outcome).toBe("allowed");
    expect(after.outcome).toBe("allowed");
    expect(after.replyText).toBe(before.replyText);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("子会社の日次 budget が超過なら、 port の有無に関わらず同じ文面で止める", async () => {
    const before = await processSubsidiaryRequest(gate(OVER, false), request());
    const after = await processSubsidiaryRequest(gate(OVER, true), request());
    expect(before.outcome).toBe("budget_exceeded");
    expect(after).toEqual(before);
    expect(runClaude).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(subRepo.recentRequests(sub.id).map((row) => row.reason)).toEqual([
      "daily budget exceeded (120000/100000 tokens)",
      "daily budget exceeded (120000/100000 tokens)",
    ]);
  });

  it("どれだけ使っていても、 上限 0 の個人を月間分で止めない", async () => {
    useMonthly(50_000_000);
    expect((await processSubsidiaryRequest(gate(UNDER, true), request())).outcome).toBe("allowed");
  });
});

describe("個人の予算が効いている個人", () => {
  it("月間分も報酬分も尽きたら、 ガードを呼ばずに止めて理由を返す (CC-PBUDGET-INV-02)", async () => {
    sub = subRepo.update(sub.id, { personal_monthly_token_budget: 1_000 })!;
    useMonthly(1_000);
    const result = await processSubsidiaryRequest(gate(UNDER, true), request());
    expect(result.outcome).toBe("budget_exceeded");
    expect(result.replyText).toContain("月間分");
    expect(result.replyText).toContain("/budget");
    expect(runClaude).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    const recorded = subRepo.recentRequests(sub.id)[0]!;
    expect(recorded).toMatchObject({ decision: "deny", reason: "personal budget: monthly_exhausted" });
    expect(recorded.violations_json).toContain("budget_exceeded");
    expect(subRepo.isLocked(sub.id, "discord", "111")).toBe(false);
  });

  it("月間分が尽きても報酬分があれば通す", async () => {
    sub = subRepo.update(sub.id, { personal_monthly_token_budget: 1_000 })!;
    useMonthly(1_000);
    budget.ledger.grant({ personId: person().id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000 });
    expect((await processSubsidiaryRequest(gate(UNDER, true), request())).outcome).toBe("allowed");
  });

  it("子会社が上限でも、 報酬分が残っている個人は通す", async () => {
    budget.ledger.grant({ personId: person().id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000 });
    const result = await processSubsidiaryRequest(gate(OVER, true), request());
    expect(result.outcome).toBe("allowed");
    expect(runClaude).toHaveBeenCalledOnce();
  });

  it("全体が超過中は、 報酬分があっても通さず、 残高を返信にも監査記録にも載せない (CC-PBUDGET-INV-03 / 08)", async () => {
    budget.ledger.grant({ personId: person().id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000 });
    globalOver = true;
    const result = await processSubsidiaryRequest(gate(OVER, true), request());
    expect(result.outcome).toBe("budget_exceeded");
    expect(result.replyText).not.toContain("300");
    expect(subRepo.recentRequests(sub.id)[0]!.reason).toBe("personal budget: global_over");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("本社内 desk の依頼者 (本社メンバー)", () => {
  it("個人の予算を適用せず、 個人の行も作らない (CC-PBUDGET-INV-07)", async () => {
    sub = subRepo.update(sub.id, { mode: "desk", personal_monthly_token_budget: 1 })!;
    const result = await processSubsidiaryRequest(gate(UNDER, true), request());
    expect(result.outcome).toBe("allowed");
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });
});
