import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BountyReportsRepo, type BountyReportCreateInput } from "./bounty-reports-repo.js";

const base: BountyReportCreateInput = {
  subsidiary_id: null,
  project_code: "Cc",
  reporter_kind: "person",
  reporter_id: "bp_1",
  reporter_session_id: null,
  recipient_reporter_id: "bp_1",
  what_happened: "スレッドが作られない",
  repro_steps: "/spawn を実行する",
  intake_platform: "discord",
  intake_key: "discord:1001",
  intake_ref_json: JSON.stringify({ channel_id: "55555" }),
  status: "received",
};
const human = { actor_kind: "human" as const, actor_id: "bp_1" };

describe("BountyReportsRepo", () => {
  it("writes the report with its received event and treats it as sensitive until triage decides", () => {
    const repo = new BountyReportsRepo(makeTestDb());
    const { row, created } = repo.create(base, human, 100);
    expect(created).toBe(true);
    expect(row.id).toMatch(/^br_[0-9a-f]{32}$/);
    expect(row).toMatchObject({
      status: "received", project_code: "Cc", sensitive: 1, verdict: null, severity: null, fix_pr: null,
      received_at: 100, updated_at: 100,
    });
    expect(repo.events(row.id)).toEqual([expect.objectContaining({
      kind: "received", from_value: null, to_value: "received", actor_kind: "human", actor_id: "bp_1", created_at: 100,
    })]);
  });

  it("returns the same report for the same idempotency key without writing again (CC-BOUNTY-INV-02)", () => {
    const repo = new BountyReportsRepo(makeTestDb());
    const first = repo.create(base, human, 100);
    const again = repo.create({ ...base, what_happened: "再送で本文が違っても書き換えない" }, human, 200);
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    expect(again.row.what_happened).toBe("スレッドが作られない");
    expect(repo.events(first.row.id)).toHaveLength(1);
    expect(repo.findByIntakeKey("discord:1001")?.id).toBe(first.row.id);
  });

  it("moves the status only from the expected state and records one event per transition", () => {
    const repo = new BountyReportsRepo(makeTestDb());
    const { row } = repo.create(base, human, 100);
    expect(repo.transition({
      id: row.id, from: "received", to: "withdrawn", patch: { withdrawn_at: 150 }, event: { kind: "withdrawn", ...human },
    }, 150)).toBe(true);
    expect(repo.find(row.id)).toMatchObject({ status: "withdrawn", withdrawn_at: 150, updated_at: 150 });
    // 同じ遷移をもう一度出しても、 状態が変わっているので書かない。
    expect(repo.transition({
      id: row.id, from: "received", to: "withdrawn", patch: { withdrawn_at: 160 }, event: { kind: "withdrawn", ...human },
    }, 160)).toBe(false);
    expect(repo.find(row.id)?.withdrawn_at).toBe(150);
    expect(repo.events(row.id).map((event) => [event.kind, event.from_value, event.to_value])).toEqual([
      ["received", null, "received"],
      ["withdrawn", "received", "withdrawn"],
    ]);
  });

  it("writes amended text together with the transition", () => {
    const repo = new BountyReportsRepo(makeTestDb());
    const { row } = repo.create({ ...base, what_happened: "", status: "needs_info" }, human, 100);
    expect(repo.transition({
      id: row.id, from: "needs_info", to: "received", patch: { what_happened: "書き足した" },
      event: { kind: "amended", ...human },
    }, 120)).toBe(true);
    expect(repo.find(row.id)).toMatchObject({ status: "received", what_happened: "書き足した", repro_steps: "/spawn を実行する" });
  });

  it("records events that do not change the status", () => {
    const repo = new BountyReportsRepo(makeTestDb());
    const { row } = repo.create(base, human, 100);
    repo.recordEvent(row.id, { kind: "notified", actor_kind: "system", to_value: "discord" }, 130);
    expect(repo.events(row.id).at(-1)).toMatchObject({ kind: "notified", actor_kind: "system", actor_id: null, to_value: "discord" });
    expect(repo.find(row.id)?.status).toBe("received");
  });

  it("rejects a status outside the declared set at the ledger", () => {
    const db = makeTestDb();
    const repo = new BountyReportsRepo(db);
    const { row } = repo.create(base, human, 100);
    expect(() => db.prepare("UPDATE bounty_reports SET status = 'merged' WHERE id = ?").run(row.id)).toThrow(/CHECK/);
  });
});
