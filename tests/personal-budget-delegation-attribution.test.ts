import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { claimPendingDelegationSpawn, recordPendingDelegationSpawn } from "../src/control/pending-delegation-spawns.js";
import { createPersonalBudget, type PersonalBudgetServices } from "../src/personal-budget/composition.js";
import { PersonalBudgetConsumption } from "../src/personal-budget/consumption-service.js";
import { inheritRequester } from "../src/personal-budget/requester-inheritance.js";
import { consumptionSessionOf, INHERITED_REQUESTER_METADATA_KEY } from "../src/personal-budget/session-facts.js";
import { localMonth } from "../src/personal-budget/types.js";

// 委託の子へ引き継いだ依頼者で、 子の消費が親の依頼者の月間分 → 報酬分の順に引かれることを固定する
// (spec/feature/personal-ai-budget.md §3 — 委託の子への依頼者の引き継ぎ)。
// 起動の経路 (invoke → pending spawn → session.started で metadata へ焼く) を metadata の形まで辿る。

const NOW = new Date(2026, 9, 14, 12).getTime();
const PERIOD = localMonth(NOW);
const PARENT_METADATA = JSON.stringify({ subsidiary_id: "glab", discord_requester_user_id: "111111111" });

let budget: PersonalBudgetServices;
let totals: Map<string, number>;
let sessionRows: { id: string; metadata: string | null; started_at: number }[];

/** 委託の起動から子セッションの metadata までを、 実際の経路と同じ値の流れで作る。 */
function spawnChild(childId: string, parentMetadata: string, cwd: string): string {
  const inherited = inheritRequester({ bodyRequesterUserId: null, parentMetadata });
  recordPendingDelegationSpawn({
    cwd, callName: "impl", requesterDiscordUserId: null,
    budgetRequester: inherited ? { subsidiary_id: inherited.subsidiaryId, discord_user_id: inherited.discordUserId } : null,
  }, NOW);
  const claimed = claimPendingDelegationSpawn(cwd, NOW + 1);
  const meta: Record<string, unknown> = {};
  if (claimed?.requesterDiscordUserId) meta.discord_requester_user_id = claimed.requesterDiscordUserId;
  if (claimed?.budgetRequester) meta[INHERITED_REQUESTER_METADATA_KEY] = { ...claimed.budgetRequester };
  const metadata = JSON.stringify(meta);
  sessionRows.push({ id: childId, metadata, started_at: Math.floor(NOW / 1000) + 1 });
  return metadata;
}

function consumption(): PersonalBudgetConsumption {
  return new PersonalBudgetConsumption({
    sessions: () => sessionRows.map(consumptionSessionOf),
    readTotal: async (id) => totals.get(id) ?? null,
    people: budget.people,
    usage: budget.usage,
    monthlyLimit: budget.monthlyLimit,
    isSubsidiaryOver: async () => false,
    now: () => NOW,
  });
}

beforeEach(() => {
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: () => 1_000,
    isGlobalOver: () => false,
    readSetting: () => null,
  });
  totals = new Map();
  sessionRows = [];
});

describe("委託の子の消費は親の依頼者へ帰属する", () => {
  it("子の消費を親の依頼者の月間分から引き、 足りないぶんを報酬分から引く (CC-PBUDGET-INV-01)", async () => {
    const parent = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111111111" }, "alice", NOW - 1_000);
    budget.ledger.grant({ personId: parent.id, kind: "tabula", sourceRef: "pub-1", tokens: 5_000, now: NOW - 1_000 });

    const childMetadata = spawnChild("child-1", PARENT_METADATA, "/wt/child-1");
    // 引き継いだ依頼者は mention 用のキーに入らない。
    expect(JSON.parse(childMetadata)).not.toHaveProperty("discord_requester_user_id");

    totals.set("child-1", 1_400);
    expect(await consumption().sampleOnce()).toEqual({ attributed: 1, skipped: 0, failed: 0 });
    expect(budget.usage.monthlyUsed(parent.id, PERIOD)).toBe(1_000);
    expect(budget.ledger.balance(parent.id)).toBe(4_600);
  });

  it("孫の消費も同じ親の依頼者へ帰属する", async () => {
    const parent = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111111111" }, "alice", NOW - 1_000);
    const childMetadata = spawnChild("child-1", PARENT_METADATA, "/wt/child-1");
    spawnChild("grandchild-1", childMetadata, "/wt/grandchild-1");

    totals.set("child-1", 300);
    totals.set("grandchild-1", 200);
    await consumption().sampleOnce();
    expect(budget.usage.monthlyUsed(parent.id, PERIOD)).toBe(500);
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it("親に依頼者が無ければ子は帰属しない (CC-PBUDGET-INV-07)", async () => {
    spawnChild("child-1", JSON.stringify({ subsidiary_id: "glab" }), "/wt/child-1");
    totals.set("child-1", 1_400);
    expect(await consumption().sampleOnce()).toEqual({ attributed: 0, skipped: 1, failed: 0 });
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });
});
