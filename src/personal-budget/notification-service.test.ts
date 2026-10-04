import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createPersonalBudget, type PersonalBudgetServices } from "./composition.js";
import { MAX_NOTICE_ATTEMPTS, PersonalBudgetNotifications } from "./notification-service.js";
import { startPeriodic } from "./periodic.js";
import type { BudgetPerson } from "./ports.js";

let budget: PersonalBudgetServices;
let person: BudgetPerson;

function notifications(send: (person: BudgetPerson, text: string) => Promise<void>, warn = vi.fn()): PersonalBudgetNotifications {
  return new PersonalBudgetNotifications({
    notices: budget.ledger,
    person: (id) => budget.people.findById(id),
    companyName: () => "GLAB",
    send,
    log: { warn },
  });
}

beforeEach(() => {
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: () => 0,
    isGlobalOver: () => false,
    readSetting: () => null,
  });
  person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" }, "alice");
});

describe("PersonalBudgetNotifications.deliverPending", () => {
  it("tells the recipient about a grant once and records the delivery", async () => {
    const { entry } = budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000 });
    const send = vi.fn(async (_person: BudgetPerson, _text: string) => undefined);
    const service = notifications(send);

    expect(await service.deliverPending()).toEqual({ delivered: 1, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ platform_user_id: "111" });
    expect(send.mock.calls[0]![1]).toContain("報酬分の残り: 300,000");
    expect(budget.ledger.findById(entry.id)).toMatchObject({ notify_state: "delivered", notify_attempts: 1 });

    expect(await service.deliverPending()).toEqual({ delivered: 0, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps the grant when the notice cannot be delivered, retries, then gives up (CC-INV-06)", async () => {
    const { entry } = budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000 });
    const warn = vi.fn();
    const service = notifications(async () => { throw new Error("Cannot send messages to this user"); }, warn);

    for (let attempt = 1; attempt < MAX_NOTICE_ATTEMPTS; attempt += 1) {
      expect(await service.deliverPending()).toEqual({ delivered: 0, failed: 1 });
      expect(budget.ledger.findById(entry.id)).toMatchObject({ notify_state: "pending", notify_attempts: attempt });
    }
    await service.deliverPending();
    expect(budget.ledger.findById(entry.id)).toMatchObject({ notify_state: "failed", notify_attempts: MAX_NOTICE_ATTEMPTS });
    expect(budget.ledger.balance(person.id)).toBe(300_000);
    // 残高をログへ出さない (CC-PBUDGET-INV-08)。
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("300,000");
    expect(logged).not.toContain("残り");

    expect(await service.deliverPending()).toEqual({ delivered: 0, failed: 0 });
  });

  it("does not notify consumption debits", async () => {
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 1_000 });
    budget.usage.applyConsumption({
      sessionId: "s1", personId: person.id, period: "2026-10", total: 400,
      plan: () => ({ delta: 400, baseline: 0, monthly: 0, reward: 400 }),
    });
    const send = vi.fn(async () => undefined);
    await notifications(send).deliverPending();
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not run two deliveries at the same time", async () => {
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 1_000 });
    let release: () => void = () => undefined;
    const send = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = notifications(send);
    const first = service.deliverPending();
    expect(await service.deliverPending()).toEqual({ delivered: 0, failed: 0 });
    release();
    expect(await first).toEqual({ delivered: 1, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("startPeriodic", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("does not overlap ticks, reports failures, and stops for good", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const warn = vi.fn();
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockImplementationOnce(async () => { throw new Error("db busy"); })
      .mockImplementation(async () => undefined);
    const handle = startPeriodic({ name: "test loop", intervalMs: 1_000, run, log: { warn } });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(warn.mock.calls[0]?.[0])).toContain("test loop tick failed: db busy");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(3);
    handle.stop();
    handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
