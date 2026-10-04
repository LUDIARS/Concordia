import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createPersonalBudget, type PersonalBudgetServices } from "./composition.js";
import { PersonalBudgetConsumption, type ConsumptionSession } from "./consumption-service.js";
import { localMonth } from "./types.js";

const NOW = new Date(2026, 9, 2, 12).getTime();
const PERIOD = localMonth(NOW);
const identity = { subsidiaryId: "glab", platform: "discord" as const, platformUserId: "111" };

let budget: PersonalBudgetServices;
let monthlyDefault: number;
let totals: Map<string, number | null>;
let sessions: ConsumptionSession[];
let subsidiaryOver: boolean;
let now: number;

function session(id: string, overrides: Partial<ConsumptionSession> = {}): ConsumptionSession {
  return { id, subsidiaryId: "glab", requesterPlatform: "discord", requesterUserId: "111", startedAtMs: NOW + 1, ...overrides };
}

function makeConsumption(): PersonalBudgetConsumption {
  return new PersonalBudgetConsumption({
    sessions: () => sessions,
    readTotal: async (id) => totals.get(id) ?? null,
    people: budget.people,
    usage: budget.usage,
    monthlyLimit: budget.monthlyLimit,
    isSubsidiaryOver: async () => subsidiaryOver,
    now: () => now,
  });
}

beforeEach(() => {
  monthlyDefault = 0;
  subsidiaryOver = false;
  now = NOW;
  totals = new Map();
  sessions = [];
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: () => monthlyDefault,
    isGlobalOver: () => false,
    readSetting: () => null,
  });
});

describe("PersonalBudgetConsumption (SPEC-PBUDGET-CONSUME)", () => {
  it("counts the positive delta of a requester's session once, across repeated samples", async () => {
    const person = budget.people.ensure(identity, "alice", NOW);
    sessions = [session("s1")];
    totals.set("s1", 1_000);
    const consumption = makeConsumption();

    expect(await consumption.sampleOnce()).toEqual({ attributed: 1, skipped: 0, failed: 0 });
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(1_000);

    // 同じ累積をもう一度見ても増えない (CC-PBUDGET-INV-05)。
    await consumption.sampleOnce();
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(1_000);

    totals.set("s1", 1_600);
    await consumption.sampleOnce();
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(1_600);
  });

  it("keeps the baseline in the database, so a restart does not bill the same tokens again", async () => {
    const person = budget.people.ensure(identity, "alice", NOW);
    sessions = [session("s1")];
    totals.set("s1", 2_000);
    await makeConsumption().sampleOnce();

    // 再起動 = 新しい use case インスタンス。 baseline は DB から読む。
    totals.set("s1", 2_500);
    await makeConsumption().sampleOnce();
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(2_500);
    expect(budget.usage.lastTotal("s1")).toBe(2_500);
  });

  it("ignores a cumulative total that went backwards", async () => {
    const person = budget.people.ensure(identity, "alice", NOW);
    sessions = [session("s1")];
    totals.set("s1", 2_000);
    const consumption = makeConsumption();
    await consumption.sampleOnce();
    totals.set("s1", 500);
    await consumption.sampleOnce();
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(2_000);
  });

  it("draws the monthly allowance first and debits the reward balance for the rest (CC-PBUDGET-INV-01)", async () => {
    monthlyDefault = 1_000;
    const person = budget.people.ensure(identity, "alice", NOW);
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 5_000, now: NOW });
    sessions = [session("s1")];
    totals.set("s1", 1_400);
    await makeConsumption().sampleOnce();

    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(1_000);
    expect(budget.ledger.balance(person.id)).toBe(4_600);
    const debit = budget.ledger.listForPerson(person.id, { limit: 10, offset: 0 }).entries.find((entry) => entry.entry_type === "debit");
    expect(debit).toMatchObject({ tokens: -400, session_id: "s1", period: PERIOD, notify_state: "none" });
  });

  it("adds later reward debits of the same session and month to the same ledger row", async () => {
    monthlyDefault = 1_000;
    const person = budget.people.ensure(identity, "alice", NOW);
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 5_000, now: NOW });
    sessions = [session("s1")];
    const consumption = makeConsumption();
    totals.set("s1", 1_400);
    await consumption.sampleOnce();
    totals.set("s1", 1_900);
    await consumption.sampleOnce();

    const debits = budget.ledger.listForPerson(person.id, { limit: 10, offset: 0 }).entries.filter((entry) => entry.entry_type === "debit");
    expect(debits).toHaveLength(1);
    expect(debits[0]!.tokens).toBe(-900);
    expect(budget.ledger.balance(person.id)).toBe(4_100);
  });

  it("never drives the reward balance below zero when a running session overshoots (CC-PBUDGET-INV-02)", async () => {
    monthlyDefault = 1_000;
    const person = budget.people.ensure(identity, "alice", NOW);
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 300, now: NOW });
    sessions = [session("s1")];
    totals.set("s1", 5_000);
    await makeConsumption().sampleOnce();

    expect(budget.ledger.balance(person.id)).toBe(0);
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(4_700);
  });

  it("does not debit the reward balance of a person without a monthly limit", async () => {
    const person = budget.people.ensure(identity, "alice", NOW);
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000, now: NOW });
    sessions = [session("s1")];
    totals.set("s1", 9_000_000);
    await makeConsumption().sampleOnce();

    expect(budget.ledger.balance(person.id)).toBe(300_000);
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(9_000_000);
  });

  it("debits the reward balance while the subsidiary cap is exceeded", async () => {
    monthlyDefault = 1_000_000;
    const person = budget.people.ensure(identity, "alice", NOW);
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 5_000, now: NOW });
    subsidiaryOver = true;
    sessions = [session("s1")];
    totals.set("s1", 700);
    await makeConsumption().sampleOnce();

    expect(budget.ledger.balance(person.id)).toBe(4_300);
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(0);
  });

  it("books a session that crosses a month boundary to the month the delta was counted in", async () => {
    const person = budget.people.ensure(identity, "alice", NOW);
    sessions = [session("s1")];
    totals.set("s1", 1_000);
    const consumption = makeConsumption();
    await consumption.sampleOnce();

    now = new Date(2026, 10, 1, 0, 5).getTime();
    totals.set("s1", 1_300);
    await consumption.sampleOnce();
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(1_000);
    expect(budget.usage.monthlyUsed(person.id, "2026-11")).toBe(300);
  });

  it("does not bill tokens used before the person was enrolled", async () => {
    sessions = [session("old", { startedAtMs: NOW - 60_000 })];
    totals.set("old", 8_000);
    const consumption = makeConsumption();
    await consumption.sampleOnce();
    const person = budget.people.find(identity)!;
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(0);

    totals.set("old", 8_250);
    await consumption.sampleOnce();
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(250);
  });

  it("skips head-office sessions and sessions without a requester (CC-PBUDGET-INV-07)", async () => {
    sessions = [
      session("hq", { subsidiaryId: null }),
      session("anonymous", { requesterPlatform: null, requesterUserId: null }),
    ];
    totals.set("hq", 1_000);
    totals.set("anonymous", 1_000);
    expect(await makeConsumption().sampleOnce()).toEqual({ attributed: 0, skipped: 2, failed: 0 });
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it("keeps counting the other sessions when one cannot be read", async () => {
    const person = budget.people.ensure(identity, "alice", NOW);
    sessions = [session("broken"), session("s2"), session("unread")];
    totals.set("s2", 400);
    totals.set("unread", null);
    const warn = vi.fn();
    const consumption = new PersonalBudgetConsumption({
      sessions: () => sessions,
      readTotal: async (id) => {
        if (id === "broken") throw new Error("transcript missing");
        return totals.get(id) ?? null;
      },
      people: budget.people,
      usage: budget.usage,
      monthlyLimit: budget.monthlyLimit,
      isSubsidiaryOver: async () => false,
      now: () => now,
      log: { warn },
    });

    expect(await consumption.sampleOnce()).toEqual({ attributed: 1, skipped: 1, failed: 1 });
    expect(budget.usage.monthlyUsed(person.id, PERIOD)).toBe(400);
    // ログには消費量や残高を出さない (CC-PBUDGET-INV-08)。
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/\d{3,}/);
  });
});
