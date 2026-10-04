import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PersonalBudgetLedgerRepo } from "./personal-budget-ledger-repo.js";
import { PersonalBudgetPeopleRepo } from "./personal-budget-people-repo.js";

let ledger: PersonalBudgetLedgerRepo;
let personId: string;

beforeEach(() => {
  const db = makeTestDb();
  ledger = new PersonalBudgetLedgerRepo(db);
  personId = new PersonalBudgetPeopleRepo(db).ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" }).id;
});

describe("PersonalBudgetLedgerRepo", () => {
  it("returns the same row for a repeated (kind, source_ref) and counts it once (CC-PBUDGET-INV-04)", () => {
    const first = ledger.grant({ personId, kind: "bounty", sourceRef: "bug-1", tokens: 500_000, now: 1_000 });
    const second = ledger.grant({ personId, kind: "bounty", sourceRef: "bug-1", tokens: 900_000, now: 2_000 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(ledger.balance(personId)).toBe(500_000);
  });

  it("keeps the same source_ref of different kinds apart", () => {
    ledger.grant({ personId, kind: "bounty", sourceRef: "1", tokens: 100 });
    ledger.grant({ personId, kind: "tabula", sourceRef: "1", tokens: 30 });
    expect(ledger.balance(personId)).toBe(130);
  });

  it("revokes once, bounded by the current balance, and reports a missing grant", () => {
    ledger.grant({ personId, kind: "bounty", sourceRef: "bug-1", tokens: 500 });
    ledger.adjust({ personId, actor: "webui", decide: () => ({ applied: -400, reason: "訂正" }) });

    // 関数が残高より大きい量を返しても、残高までしか引かない。
    const revoked = ledger.revoke({ kind: "bounty", sourceRef: "bug-1", reason: "判定が覆った", decide: () => 9_999 });
    expect(revoked).toMatchObject({ created: true, entry: { entry_type: "revoke", tokens: -100, reason: "判定が覆った" } });
    expect(ledger.balance(personId)).toBe(0);

    expect(ledger.revoke({ kind: "bounty", sourceRef: "bug-1", reason: "再送", decide: () => 1 }))
      .toMatchObject({ created: false, entry: { tokens: -100 } });
    expect(ledger.revoke({ kind: "bounty", sourceRef: "bug-404", reason: "x", decide: () => 1 })).toBeNull();
  });

  it("decides an adjustment against the balance read inside the transaction and never goes negative", () => {
    ledger.adjust({ personId, actor: "discord:900", decide: () => ({ applied: 300, reason: "付与" }), now: 1_000 });
    const seen: number[] = [];
    const reduced = ledger.adjust({
      personId, actor: "discord:900", now: 2_000,
      decide: (balance) => { seen.push(balance); return { applied: -5_000, reason: "減額" }; },
    });
    expect(seen).toEqual([300]);
    expect(reduced).toMatchObject({ entry_type: "manual", reward_kind: "manual", tokens: -300, actor: "discord:900", reason: "減額" });
    expect(reduced!.source_ref).toBe(reduced!.id);
    expect(ledger.balance(personId)).toBe(0);

    expect(ledger.adjust({ personId, actor: "x", decide: () => null })).toBeNull();
    expect(ledger.adjust({ personId, actor: "x", decide: () => ({ applied: -1, reason: "残高なし" }) })).toBeNull();
    expect(ledger.listForPerson(personId, { limit: 10, offset: 0 }).total).toBe(2);
  });

  it("lists a person's ledger newest first and pages it", () => {
    for (let i = 0; i < 5; i += 1) ledger.grant({ personId, kind: "bounty", sourceRef: `bug-${i}`, tokens: 1, now: 1_000 + i });
    const page = ledger.listForPerson(personId, { limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.entries.map((entry) => entry.source_ref)).toEqual(["bug-3", "bug-2"]);
    expect(ledger.listForPerson("pbp_other", { limit: 10, offset: 0 })).toEqual({ entries: [], total: 0 });
  });

  it("tracks notice delivery separately from the grant", () => {
    const { entry } = ledger.grant({ personId, kind: "tabula", sourceRef: "pub-1", tokens: 10 });
    expect(ledger.listPendingNotices(10).map((notice) => notice.id)).toEqual([entry.id]);

    ledger.markNoticeFailed(entry.id, false);
    expect(ledger.findById(entry.id)).toMatchObject({ notify_state: "pending", notify_attempts: 1 });
    ledger.markNoticeDelivered(entry.id);
    expect(ledger.findById(entry.id)).toMatchObject({ notify_state: "delivered", notify_attempts: 2 });
    // 配達済みの行は後から失敗に戻らない。
    ledger.markNoticeFailed(entry.id, true);
    expect(ledger.findById(entry.id)).toMatchObject({ notify_state: "delivered", notify_attempts: 2 });
    expect(ledger.listPendingNotices(10)).toEqual([]);
    expect(ledger.balance(personId)).toBe(10);
  });
});
