import { describe, expect, it } from "vitest";
import {
  BUDGET_EXHAUSTED_REASON,
  BUDGET_SUSPENSION_KEY,
  canResumeSuspension,
  conversationIdFromTranscript,
  decideBudgetGate,
  isResumable,
  readSuspension,
  type BudgetSuspension,
} from "./budget-suspension.js";
import { evaluateBudget } from "./usage-budget.js";

const suspension: BudgetSuspension = {
  suspended_at: 1,
  scope: "user",
  target_id: "111111111",
  conversation_id: "9914dcf2-7e21-4fcd-96ae-7dfe7c64d662",
  cwd: "E:/Document/Ars",
  participants: ["111111111", "222222222"],
};

describe("decideBudgetGate", () => {
  it("帰属先の予算が尽きていれば理由つきで止め、 予算が無い・残っていれば止めない", () => {
    const subject = { scope: "user" as const, targetId: "111111111" };
    expect(decideBudgetGate({ subject, evaluation: evaluateBudget(1_000, 1_000) })).toEqual({ deny: true, reason: BUDGET_EXHAUSTED_REASON });
    expect(decideBudgetGate({ subject, evaluation: evaluateBudget(999, 1_000) })).toEqual({ deny: false, reason: null });
    expect(decideBudgetGate({ subject, evaluation: null })).toEqual({ deny: false, reason: null });
    expect(decideBudgetGate({ subject: null, evaluation: evaluateBudget(1, 0) })).toEqual({ deny: false, reason: null });
  });
});

describe("canResumeSuspension / isResumable", () => {
  it("押せるのは起動者・助けに入った人・管理者だけ", () => {
    expect(canResumeSuspension({ suspension, actorUserId: "222222222", actorIsAdmin: false })).toBe(true);
    expect(canResumeSuspension({ suspension, actorUserId: "333333333", actorIsAdmin: false })).toBe(false);
    expect(canResumeSuspension({ suspension, actorUserId: "333333333", actorIsAdmin: true })).toBe(true);
  });

  it("予算が戻った未再開の中断だけを再開できる", () => {
    expect(isResumable({ suspension, evaluation: evaluateBudget(0, 1_000) })).toBe(true);
    expect(isResumable({ suspension, evaluation: null })).toBe(true);
    expect(isResumable({ suspension, evaluation: evaluateBudget(1_000, 1_000) })).toBe(false);
    expect(isResumable({ suspension: { ...suspension, resumed_at: 5 }, evaluation: null })).toBe(false);
    expect(isResumable({ suspension: { ...suspension, conversation_id: null }, evaluation: null })).toBe(false);
  });
});

describe("readSuspension / conversationIdFromTranscript", () => {
  it("metadata の中断の記録を読み、 壊れていれば null", () => {
    expect(readSuspension(JSON.stringify({ [BUDGET_SUSPENSION_KEY]: suspension }))).toMatchObject(suspension);
    expect(readSuspension(JSON.stringify({ [BUDGET_SUSPENSION_KEY]: { scope: "org" } }))).toBeNull();
    expect(readSuspension("{broken")).toBeNull();
  });

  it("transcript のファイル名 (UUID) を会話 id とする", () => {
    expect(conversationIdFromTranscript("C:\\Users\\x\\.claude\\projects\\E--Document-Ars\\9914dcf2-7e21-4fcd-96ae-7dfe7c64d662.jsonl"))
      .toBe("9914dcf2-7e21-4fcd-96ae-7dfe7c64d662");
    expect(conversationIdFromTranscript("/tmp/rollout-2026.jsonl")).toBeNull();
    expect(conversationIdFromTranscript(null)).toBeNull();
  });
});
