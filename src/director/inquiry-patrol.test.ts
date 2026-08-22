import { describe, expect, it } from "vitest";
import {
  escapeLikePattern,
  inquiryDailyCountPatterns,
  inquiryTriggeredBy,
  judgeStall,
  planInquiries,
  type InquiryCandidate,
} from "./inquiry-patrol.js";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function candidate(overrides: Partial<InquiryCandidate> = {}): InquiryCandidate {
  return {
    caseId: "case-1",
    reason: "run-failed",
    stepId: "step-1",
    detail: "run が失敗しました",
    ...overrides,
  };
}

function plan(candidates: InquiryCandidate[], overrides: {
  unanswered?: Set<string>;
  today?: Record<string, number>;
  limits?: Parameters<typeof planInquiries>[0]["limits"];
} = {}) {
  return planInquiries({
    candidates,
    hasExistingInquiry: () => false,
    hasUnansweredDecision: (caseId) => overrides.unanswered?.has(caseId) ?? false,
    countInquiriesToday: (caseId) => overrides.today?.[caseId] ?? 0,
    limits: overrides.limits,
  });
}

describe("inquiryTriggeredBy", () => {
  it("uses the step id and includes the UTC day so the key is idempotent per day", () => {
    expect(inquiryTriggeredBy({ stepId: "step-1", caseId: "case-1", reason: "run-failed", now: NOW }))
      .toBe("director-inquiry:step-1:run-failed:2026-08-20");
  });

  it("falls back to the case id when the reason has no step (stalled)", () => {
    expect(inquiryTriggeredBy({ stepId: null, caseId: "case-1", reason: "stalled", now: NOW }))
      .toBe("director-inquiry:case-1:stalled:2026-08-20");
  });

  it("changes with the UTC day so a new day allows a new inquiry", () => {
    const next = Date.parse("2026-08-21T00:00:00.000Z");
    expect(inquiryTriggeredBy({ stepId: "step-1", caseId: "case-1", reason: "run-failed", now: next }))
      .not.toBe(inquiryTriggeredBy({ stepId: "step-1", caseId: "case-1", reason: "run-failed", now: NOW }));
  });
});

describe("planInquiries guards", () => {
  it("launches a candidate when nothing blocks it", () => {
    const [result] = plan([candidate()]);
    expect(result?.launch).toBe(true);
    expect(result?.skipReason).toBeUndefined();
  });

  it("keeps the machine-written card while an unanswered decision remains on the case", () => {
    const [result] = plan([candidate()], { unanswered: new Set(["case-1"]) });
    expect(result?.launch).toBe(false);
    expect(result?.skipReason).toBe("unanswered-decision");
  });

  it("stops at the daily quota for a case", () => {
    const [result] = plan([candidate()], { today: { "case-1": 3 } });
    expect(result?.launch).toBe(false);
    expect(result?.skipReason).toBe("daily-quota");
  });

  it("counts inquiries launched earlier in the same tick toward the daily quota", () => {
    const results = plan(
      [
        candidate({ reason: "run-failed", stepId: "step-1" }),
        candidate({ reason: "run-missing", stepId: "step-2" }),
      ],
      { today: { "case-1": 2 }, limits: { maxLaunchesPerTick: 5 } },
    );
    expect(results[0]?.launch).toBe(true);
    expect(results[1]?.launch).toBe(false);
    expect(results[1]?.skipReason).toBe("daily-quota");
  });

  it("launches at most one inquiry per tick and defers the rest to the card", () => {
    const results = plan([
      candidate({ caseId: "case-1" }),
      candidate({ caseId: "case-2" }),
    ]);
    expect(results[0]?.launch).toBe(true);
    expect(results[1]?.launch).toBe(false);
    expect(results[1]?.skipReason).toBe("tick-quota");
  });

  it("does not let an already-launched candidate consume the tick quota", () => {
    const results = planInquiries({
      candidates: [candidate({ caseId: "case-old" }), candidate({ caseId: "case-new" })],
      hasExistingInquiry: (value) => value.caseId === "case-old",
      hasUnansweredDecision: () => false,
      countInquiriesToday: () => 0,
    });
    expect(results[0]).toMatchObject({ launch: false, skipReason: "already-launched" });
    expect(results[1]).toMatchObject({ launch: true });
  });

  it("never drops a candidate — every one is either launched or kept as a card", () => {
    const candidates = [
      candidate({ caseId: "case-1" }),
      candidate({ caseId: "case-2" }),
      candidate({ caseId: "case-3" }),
    ];
    const results = plan(candidates, { unanswered: new Set(["case-2"]) });
    expect(results).toHaveLength(candidates.length);
    expect(results.map((r) => r.candidate.caseId)).toEqual(["case-1", "case-2", "case-3"]);
  });
});

describe("judgeStall", () => {
  const base = { hasOpenWork: true, hasExecutableStep: false, hasActiveStep: false, stallTicks: 0 };

  it("resets when the case has no open work", () => {
    expect(judgeStall({ ...base, hasOpenWork: false, stallTicks: 3 })).toEqual({ type: "reset" });
  });

  it("resets when an executable step exists", () => {
    expect(judgeStall({ ...base, hasExecutableStep: true, stallTicks: 3 })).toEqual({ type: "reset" });
  });

  it("does not count a case whose step is still running as stalled", () => {
    expect(judgeStall({ ...base, hasActiveStep: true, stallTicks: 3 })).toEqual({ type: "reset" });
  });

  it("bumps below the threshold", () => {
    expect(judgeStall({ ...base, stallTicks: 2 })).toEqual({ type: "bump", ticks: 3 });
  });

  it("reports stalled once the threshold is reached", () => {
    expect(judgeStall({ ...base, stallTicks: 3 })).toEqual({ type: "stalled", ticks: 4 });
  });

  it("honours a custom threshold", () => {
    expect(judgeStall({ ...base, stallTicks: 0, limits: { stallTicks: 1 } }))
      .toEqual({ type: "stalled", ticks: 1 });
  });
});

describe("inquiryDailyCountPatterns", () => {
  it("covers the case id and every step id for the given day", () => {
    const patterns = inquiryDailyCountPatterns({ caseId: "case-1", stepIds: ["step-1", "step-2"], now: NOW });
    expect(patterns).toEqual([
      "director-inquiry:case-1:%:2026-08-20",
      "director-inquiry:step-1:%:2026-08-20",
      "director-inquiry:step-2:%:2026-08-20",
    ]);
  });

  it("does not repeat a subject that appears twice", () => {
    const patterns = inquiryDailyCountPatterns({ caseId: "case-1", stepIds: ["case-1"], now: NOW });
    expect(patterns).toHaveLength(1);
  });

  it("escapes LIKE wildcards so an id cannot widen the match", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});
