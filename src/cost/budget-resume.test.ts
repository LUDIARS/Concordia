import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { BUDGET_SUSPENSION_KEY, readSuspension, type BudgetSuspension } from "./budget-suspension.js";
import { BUDGET_RESUME_OFFER_TEXT, offerBudgetResumes, resumeSuspendedSession } from "./budget-resume.js";
import { evaluateBudget } from "./usage-budget.js";

const suspension: BudgetSuspension = {
  suspended_at: 1,
  scope: "user",
  target_id: "111111111",
  conversation_id: "9914dcf2-7e21-4fcd-96ae-7dfe7c64d662",
  cwd: "E:/Document/Ars",
  participants: ["111111111", "222222222"],
  resume_offered_at: null,
  resumed_at: null,
  resumed_by: null,
};

function store(record: BudgetSuspension = suspension) {
  const session = { id: "s1", metadata: JSON.stringify({ [BUDGET_SUSPENSION_KEY]: record }) } as unknown as SessionRow;
  return {
    session,
    findSession: (id: string) => (id === "s1" ? session : null),
    mergeMetadata: (_id: string, partial: Record<string, unknown>) => {
      session.metadata = JSON.stringify({ ...JSON.parse(session.metadata ?? "{}"), ...partial });
    },
  };
}

describe("offerBudgetResumes", () => {
  it("予算が戻った中断にだけ、 1 回だけ「再開」を出す", async () => {
    const s = store();
    const offer = vi.fn();
    let exhausted = true;
    const deps = {
      listSuspended: () => [s.session],
      status: async () => evaluateBudget(exhausted ? 1_000 : 0, 1_000),
      mergeMetadata: s.mergeMetadata,
      offer,
      now: () => 5,
    };
    expect(await offerBudgetResumes(deps)).toEqual([]);
    exhausted = false;
    expect(await offerBudgetResumes(deps)).toEqual(["s1"]);
    expect(await offerBudgetResumes(deps)).toEqual([]);
    expect(offer).toHaveBeenCalledWith("s1", BUDGET_RESUME_OFFER_TEXT);
    expect(readSuspension(s.session.metadata)?.resume_offered_at).toBe(5);
  });
});

describe("resumeSuspendedSession", () => {
  function deps(s: ReturnType<typeof store>, overrides: Partial<Parameters<typeof resumeSuspendedSession>[0]> = {}) {
    return {
      findSession: s.findSession,
      mergeMetadata: s.mergeMetadata,
      status: async () => evaluateBudget(0, 1_000),
      isAdmin: () => false,
      launch: vi.fn(async () => ({ ok: true as const, pid: 42 })),
      now: () => 9,
      ...overrides,
    };
  }

  it("押せる人が押し、 予算が戻っていれば claude --resume で起動し直して再開を記録する", async () => {
    const s = store();
    const d = deps(s);
    expect(await resumeSuspendedSession(d, "s1", "222222222")).toEqual({ ok: true, pid: 42 });
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(readSuspension(s.session.metadata)).toMatchObject({ resumed_at: 9, resumed_by: "222222222", resumed_pid: 42 });
    // 二度目は起動しない。
    expect(await resumeSuspendedSession(d, "s1", "222222222")).toMatchObject({ ok: false, status: 409 });
    expect(d.launch).toHaveBeenCalledTimes(1);
  });

  it("関係の無い人・予算がまだ尽きている・起動に失敗した場合は再開しない", async () => {
    expect(await resumeSuspendedSession(deps(store()), "s1", "333333333")).toMatchObject({ ok: false, status: 403 });
    expect(await resumeSuspendedSession(deps(store(), { isAdmin: () => true }), "s1", "333333333")).toMatchObject({ ok: true });
    expect(await resumeSuspendedSession(deps(store(), { status: async () => evaluateBudget(1_000, 1_000) }), "s1", "111111111"))
      .toMatchObject({ ok: false, status: 402 });
    const failing = store();
    expect(await resumeSuspendedSession(deps(failing, { launch: async () => ({ ok: false, error: "spawn failed" }) }), "s1", "111111111"))
      .toMatchObject({ ok: false, status: 502 });
    // 起動に失敗したら押し直せる。
    expect(readSuspension(failing.session.metadata)?.resumed_at).toBeNull();
    expect(await resumeSuspendedSession(deps(store()), "missing", "111111111")).toMatchObject({ ok: false, status: 404 });
  });
});
