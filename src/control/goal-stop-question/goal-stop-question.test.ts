import { describe, expect, it, vi } from "vitest";
import type { SessionEventRow } from "../../shared/types.js";
import { createGoalStopQuestionGuard, goalStopAnswerText, postedQuestionOf, type PostedQuestion } from "./guard.js";
import { recentHumanInstructions } from "./human-instructions.js";
import { buildGoalStopPrompt, claudeGoalStopJudge, parseGoalStopVerdict } from "./judge.js";
import { prefilterGoalStopQuestion } from "./prefilter.js";

// The question that started this (2026-11-12): the goal was given, the session asked whether to do it.
const GOAL = "「neco」さんからの指示: Amiciiクライアント含めて周回できるようになったら教えて";
const BLOCKING = {
  question: "実機周回に進むため、2 点を決めてください。",
  options: ["Excubitor の信頼先に Amicii を足す", "ingenium playtest の実行を許可", "周回は今回は見送る"],
};

function inject(id: number, source: string, text: string): SessionEventRow {
  return { id, session_id: "s-1", ts: id, kind: "inject", payload: JSON.stringify({ source, text }) };
}

const VERDICT_OK = JSON.stringify({ goal_blocking: true, goal_ambiguous: false, destructive: false, collides: false, confidence: 0.9, reason: "前提整備を選ばせている" });

function posted(overrides: Partial<PostedQuestion> = {}): PostedQuestion {
  return { sessionId: "s-1", questionId: 7, kind: "question", question: BLOCKING.question, options: BLOCKING.options, hasParent: false, ...overrides };
}

function setup(options: { enabled?: boolean; active?: boolean; events?: SessionEventRow[]; verdict?: string; answered?: boolean } = {}) {
  const answer = vi.fn(() => (options.answered ? { ok: false as const, status: 409, error: "already_answered" } : { ok: true as const, answer_text: "x" }));
  const record = vi.fn();
  const judge = vi.fn(async () => parseGoalStopVerdict(options.verdict ?? VERDICT_OK));
  const guard = createGoalStopQuestionGuard({
    isEnabled: () => options.enabled ?? true,
    isActiveSession: () => options.active ?? true,
    recentEvents: () => options.events ?? [inject(2, "discord:neco:ch", GOAL)],
    judge,
    answer: answer as never,
    record,
  });
  return { guard, answer, record, judge };
}

describe("prefilterGoalStopQuestion (SPEC-GOAL-STOP-Q-01)", () => {
  it("takes a question that offers to go ahead or to skip", () => {
    expect(prefilterGoalStopQuestion(BLOCKING)).toEqual({ candidate: true, reason: "go-question" });
  });
  it("leaves destructive questions to the human", () => {
    expect(prefilterGoalStopQuestion({ question: "古いデータを削除して進めますか", options: ["削除する", "見送る"] }).reason).toBe("destructive");
    expect(prefilterGoalStopQuestion({ question: "main に force push しますか", options: ["する", "しない"] }).reason).toBe("destructive");
  });
  it("leaves questions that do not ask whether to go ahead", () => {
    expect(prefilterGoalStopQuestion({ question: "どちらの色を使いますか", options: ["赤", "青"] }).candidate).toBe(false);
  });
});

describe("parseGoalStopVerdict (SPEC-GOAL-STOP-Q-02)", () => {
  it("judges only a confident, safe, goal-blocking answer", () => {
    expect(parseGoalStopVerdict(`note ${VERDICT_OK} end`).goalBlocking).toBe(true);
    const low = JSON.parse(VERDICT_OK) as Record<string, unknown>;
    for (const change of [{ confidence: 0.5 }, { destructive: true }, { goal_ambiguous: true }, { collides: true }, { goal_blocking: false }, { collides: undefined }]) {
      expect(parseGoalStopVerdict(JSON.stringify({ ...low, ...change })).goalBlocking).toBe(false);
    }
    expect(parseGoalStopVerdict("not json").goalBlocking).toBe(false);
  });
  it("puts the instructions and the question in the prompt as data", () => {
    const prompt = buildGoalStopPrompt([GOAL], BLOCKING);
    expect(prompt).toContain(JSON.stringify([GOAL]));
    expect(prompt).toContain(JSON.stringify(BLOCKING.options));
  });
  it("does not judge when claude fails", async () => {
    const judge = claudeGoalStopJudge(async () => ({ ok: false, stdout: VERDICT_OK, stderr: "" }));
    expect((await judge([GOAL], BLOCKING)).goalBlocking).toBe(false);
    const throws = claudeGoalStopJudge(async () => { throw new Error("down"); });
    expect((await throws([GOAL], BLOCKING)).goalBlocking).toBe(false);
  });
});

describe("recentHumanInstructions (SPEC-GOAL-STOP-Q-03)", () => {
  it("keeps the human's injects, oldest first, and drops automatic ones", () => {
    const events = [inject(4, "auto:goal-and-go", "続けてください"), inject(3, "slack:u1:c", "二つ目"), inject(2, "discord:neco:ch", "一つ目"), inject(1, "delegation:r1:question", "委託")];
    expect(recentHumanInstructions(events)).toEqual(["一つ目", "二つ目"]);
    expect(recentHumanInstructions(events, 1)).toEqual(["二つ目"]);
  });
});

describe("createGoalStopQuestionGuard (SPEC-GOAL-STOP-Q-04)", () => {
  it("answers a goal-blocking question through the answer path and records it", async () => {
    const ctx = setup();
    expect(await ctx.guard.onQuestionPosted(posted())).toBe("answered");
    expect(ctx.judge).toHaveBeenCalledWith([GOAL], BLOCKING);
    expect(ctx.answer).toHaveBeenCalledWith("s-1", 7, goalStopAnswerText("前提整備を選ばせている"));
    expect(ctx.record).toHaveBeenCalledOnce();
  });
  it("leaves the question to the human when it cannot or should not judge", async () => {
    const cases: Array<[Parameters<typeof setup>[0], PostedQuestion]> = [
      [{ enabled: false }, posted()],
      [{ active: false }, posted()],
      [{}, posted({ kind: "plan_approval" })],
      [{}, posted({ hasParent: true })],
      [{ events: [inject(1, "auto:goal-and-go", "続けて")] }, posted()],
      [{ verdict: "{}" }, posted()],
      [{}, posted({ question: "どちらの色を使いますか", options: ["赤", "青"] })],
    ];
    for (const [options, question] of cases) {
      const ctx = setup(options);
      expect(await ctx.guard.onQuestionPosted(question)).toBe("skipped");
      expect(ctx.answer).not.toHaveBeenCalled();
    }
  });
  it("does nothing more when the human answered first", async () => {
    const ctx = setup({ answered: true });
    expect(await ctx.guard.onQuestionPosted(posted())).toBe("skipped");
    expect(ctx.record).not.toHaveBeenCalled();
  });
  it("reads question.posted events (string and labelled options)", () => {
    const read = postedQuestionOf({ type: "question.posted", target_session_id: "s-1", question_id: 3, question: "q", options: ["a", { label: "b" }], parent_session_id: "p", ts: 1 });
    expect(read).toEqual({ sessionId: "s-1", questionId: 3, kind: "question", question: "q", options: ["a", "b"], hasParent: true });
    expect(postedQuestionOf({ type: "question.resolved", target_session_id: "s-1", question_id: 3, ts: 1 })).toBeNull();
  });
});
