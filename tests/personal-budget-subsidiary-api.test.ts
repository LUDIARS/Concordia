import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { subsidiaryRouter } from "../src/api/subsidiary.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { SubsidiaryRepo } from "../src/db/subsidiary-repo.js";
import { TeamsRepo } from "../src/db/teams-repo.js";
import { createPersonalBudget } from "../src/personal-budget/composition.js";
import { SubsidiaryBotManager } from "../src/subsidiary/manager.js";

// 子会社の設定 API が持つ「個人の月間分の既定値」(spec/feature/personal-ai-budget.md §3) と、
// 子会社 Bot の管理がゲートへ個人の予算の port を渡すこと。

function makeApp() {
  const db = makeTestDb();
  const repo = new SubsidiaryRepo(db);
  const app = new Hono().route("/v1/subsidiaries", subsidiaryRouter({
    repo,
    delegationRepo: new DelegationRepo(db),
    manager: { isRunning: () => false, stop: async () => ({ ok: true }) } as never,
    secretBox: { encrypt: (s: string) => s, decrypt: (s: string) => s } as never,
    teams: new TeamsRepo(db),
  }));
  return { app, repo, db };
}

async function send(app: Hono, method: string, path: string, body: unknown) {
  const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as { subsidiary?: Record<string, unknown> } | null };
}

describe("子会社 API: personal_monthly_token_budget", () => {
  it("既定は 0 (上限なし) で、 作成・更新で設定できる", async () => {
    const { app } = makeApp();
    const created = await send(app, "POST", "/v1/subsidiaries", { name: "glab", platform: "discord" });
    expect(created.status).toBe(201);
    expect(created.body?.subsidiary?.personal_monthly_token_budget).toBe(0);

    const id = String(created.body?.subsidiary?.id);
    const patched = await send(app, "PATCH", `/v1/subsidiaries/${id}`, { personal_monthly_token_budget: 2_000_000 });
    expect(patched.body?.subsidiary?.personal_monthly_token_budget).toBe(2_000_000);
    // 他の項目の更新で消えない。
    const renamed = await send(app, "PATCH", `/v1/subsidiaries/${id}`, { display_name: "GLAB" });
    expect(renamed.body?.subsidiary).toMatchObject({ display_name: "GLAB", personal_monthly_token_budget: 2_000_000 });

    const withBudget = await send(app, "POST", "/v1/subsidiaries", {
      name: "vantan", platform: "discord", personal_monthly_token_budget: 500_000, max_sessions: 3,
    });
    expect(withBudget.body?.subsidiary?.personal_monthly_token_budget).toBe(500_000);
    expect(withBudget.body?.subsidiary?.max_sessions).toBe(3);
    const updatedBudget = await send(app, "PATCH", `/v1/subsidiaries/${withBudget.body?.subsidiary?.id}`, {
      personal_monthly_token_budget: 600_000,
    });
    expect(updatedBudget.body?.subsidiary).toMatchObject({ personal_monthly_token_budget: 600_000, max_sessions: 3 });
    const updatedCap = await send(app, "PATCH", `/v1/subsidiaries/${withBudget.body?.subsidiary?.id}`, { max_sessions: 5 });
    expect(updatedCap.body?.subsidiary).toMatchObject({ personal_monthly_token_budget: 600_000, max_sessions: 5 });
  });

  it("負・小数・上限超えは受けない", async () => {
    const { app } = makeApp();
    for (const value of [-1, 1.5, 1_000_000_001]) {
      const res = await send(app, "POST", "/v1/subsidiaries", { name: "glab", platform: "discord", personal_monthly_token_budget: value });
      expect(res.status).toBe(400);
    }
  });

  it("子会社の既定値が、 個人の上書きが無い人の月間分の上限になる", async () => {
    const { app, repo, db } = makeApp();
    const created = await send(app, "POST", "/v1/subsidiaries", {
      name: "glab", platform: "discord", personal_monthly_token_budget: 750_000,
    });
    const id = String(created.body?.subsidiary?.id);
    const budget = createPersonalBudget({
      db,
      subsidiaryMonthlyDefault: (subsidiaryId) => repo.find(subsidiaryId)?.personal_monthly_token_budget ?? null,
      isGlobalOver: () => false,
      readSetting: () => null,
    });
    const person = budget.people.ensure({ subsidiaryId: id, platform: "discord", platformUserId: "111" });
    expect(budget.view.summarize(person)).toMatchObject({ monthlyLimit: 750_000, monthlyRemaining: 750_000 });
  });
});

describe("SubsidiaryBotManager: 個人の予算の port をゲートへ渡す", () => {
  it("port が止めた依頼は、 ガードも起動も呼ばずに理由を返す", async () => {
    const { repo, db } = makeApp();
    const sub = repo.create({ name: "glab", platform: "discord", enabled: true, guild_id: "g1" });
    const admit = (request: unknown) => {
      seen.push(request);
      return { allow: false as const, reason: "monthly_exhausted" as const, rewardBalance: 0, inEffect: true };
    };
    const seen: unknown[] = [];
    let guardCalls = 0;
    const manager = new SubsidiaryBotManager({
      subsidiaryRepo: repo,
      harnessRepo: { list: () => [] } as never,
      delegationRepo: new DelegationRepo(db),
      delegationService: { invokeDefinition: async () => { throw new Error("must not spawn"); } } as never,
      headOfficeDiscord: () => ({
        enabled: false, token: null, guildId: null, applicationId: null,
        permissionRequestsEnabled: false, messageOptimizationEnabled: false,
      }),
      runClaude: (async () => { guardCalls += 1; return { ok: true, stdout: "", stderr: "" }; }) as never,
      budgetTracker: { status: async () => ({ todayTokens: 0, budget: 0, blocked: false, dateIso: "2026-10-02" }) } as never,
      personalBudget: { admit },
      baseDiscordDeps: () => ({}),
      startBot: async () => null,
    });

    const result = await manager.processorFor(sub.id).process("111", "alice", "README を直して");
    expect(result.replyText).toContain("月間分");
    expect(result.replyText).toContain("/budget");
    expect(guardCalls).toBe(0);
    expect(seen).toEqual([{ subsidiaryId: sub.id, platform: "discord", userId: "111", userLabel: "alice", subsidiaryOver: false }]);
  });
});
