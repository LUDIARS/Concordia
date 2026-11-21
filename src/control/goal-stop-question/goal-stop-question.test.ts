import { describe, expect, it, vi } from "vitest";
import type { GeniusCard } from "../../inquiry/genius-client.js";
import type { SessionEventRow } from "../../shared/types.js";
import { gateGeniusCards, geniusEvidenceLookup, GOAL_STOP_GENIUS_CATEGORIES } from "./genius-evidence.js";
import { createGoalStopQuestionGuard, goalStopAnswerText, postedQuestionOf, type PostedQuestion } from "./guard.js";
import { recentHumanInstructions } from "./human-instructions.js";
import { buildGeniusAnswerPrompt, claudeGeniusAnswerJudge, parseGeniusAnswer } from "./judge.js";
import { prefilterGoalStopQuestion } from "./prefilter.js";

// The question that started this (2026-11-12): the goal was given, the session asked whether to do it.
const GOAL = "「neco」さんからの指示: Amiciiクライアント含めて周回できるようになったら教えて";
const BLOCKING = {
  question: "実機周回に進むため、2 点を決めてください。",
  options: ["Excubitor の信頼先に Amicii を足す", "ingenium playtest の実行を許可", "周回は今回は見送る"],
};
const CARD: GeniusCard = {
  id: "card-goal-1",
  title: "ゴールに必要な前提整備",
  score: 0.82,
  judgment: "依頼済みゴールの前提整備は確認せず進める",
};

function inject(id: number, source: string, text: string): SessionEventRow {
  return { id, session_id: "s-1", ts: id, kind: "inject", payload: JSON.stringify({ source, text }) };
}

const ANSWER_OK = JSON.stringify({ covered: true, option_index: 0, answer: "前提整備なので進める", card_ids: ["card-goal-1"], confidence: 0.9 });

function posted(overrides: Partial<PostedQuestion> = {}): PostedQuestion {
  return { sessionId: "s-1", questionId: 7, kind: "question", question: BLOCKING.question, options: BLOCKING.options, hasParent: false, ...overrides };
}

function setup(options: { enabled?: boolean; active?: boolean; events?: SessionEventRow[]; cards?: GeniusCard[] | null; verdict?: string; answered?: boolean } = {}) {
  const answer = vi.fn(() => (options.answered ? { ok: false as const, status: 409 as const, error: "already_answered" } : { ok: true as const, answer_text: "x" }));
  const record = vi.fn();
  const cards = options.cards === undefined ? [CARD] : options.cards;
  const evidence = vi.fn(async () => gateGeniusCards(cards, 0.6));
  const judge = vi.fn(async (given: GeniusCard[]) => parseGeniusAnswer(options.verdict ?? ANSWER_OK, given, BLOCKING.options.length));
  const guard = createGoalStopQuestionGuard({
    isEnabled: () => options.enabled ?? true,
    isActiveSession: () => options.active ?? true,
    recentEvents: () => options.events ?? [inject(2, "discord:neco:ch", GOAL)],
    evidence,
    judge,
    answer,
    record,
  });
  return { guard, answer, record, judge, evidence };
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

describe("gateGeniusCards (SPEC-GOAL-STOP-Q-05)", () => {
  it("answers only on a precedent card above the score", () => {
    expect(gateGeniusCards([CARD, { ...CARD, id: "low", score: 0.3 }], 0.6)).toEqual({ ok: true, cards: [CARD] });
  });
  it("leaves the question to the human when Genius cannot judge", () => {
    expect(gateGeniusCards(null, 0.6)).toEqual({ ok: false, reason: "genius_unavailable" });
    expect(gateGeniusCards([], 0.6)).toEqual({ ok: false, reason: "no_precedent" });
    expect(gateGeniusCards([{ ...CARD, score: 0.5 }], 0.6)).toEqual({ ok: false, reason: "no_precedent" });
    expect(gateGeniusCards([CARD, { ...CARD, id: "h", tags: ["人間判断"] }], 0.6)).toEqual({ ok: false, reason: "needs_human" });
  });
  it("queries Genius with the question and treats failures as unavailable", async () => {
    const query = vi.fn(async () => [CARD]);
    const lookup = geniusEvidenceLookup({ query }, () => 0.6);
    expect(await lookup(BLOCKING, [GOAL])).toEqual({ ok: true, cards: [CARD] });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ categories: GOAL_STOP_GENIUS_CATEGORIES, text: expect.stringContaining(BLOCKING.question) }));
    const down = geniusEvidenceLookup({ query: async () => { throw new Error("down"); } }, () => 0.6);
    expect(await down(BLOCKING, [GOAL])).toEqual({ ok: false, reason: "genius_unavailable" });
  });
});

describe("parseGeniusAnswer (SPEC-GOAL-STOP-Q-02)", () => {
  it("answers only with a confident choice grounded in a given card", () => {
    const ok = parseGeniusAnswer(`note ${ANSWER_OK} end`, [CARD], 3);
    expect(ok).toEqual({ answered: true, answer: { optionIndex: 0, text: "前提整備なので進める", cardIds: ["card-goal-1"], confidence: 0.9 } });
    const base = JSON.parse(ANSWER_OK) as Record<string, unknown>;
    for (const change of [{ covered: false }, { confidence: 0.5 }, { card_ids: ["unknown"] }, { card_ids: [] }, { option_index: 3 }, { option_index: 1.5 }, { option_index: null, answer: "" }]) {
      expect(parseGeniusAnswer(JSON.stringify({ ...base, ...change }), [CARD], 3).answered).toBe(false);
    }
    expect(parseGeniusAnswer("not json", [CARD], 3).answered).toBe(false);
  });
  it("accepts a free-text answer with rationale", () => {
    const free = parseGeniusAnswer(JSON.stringify({ covered: true, option_index: null, answer: "上限 1 回で実行する", card_ids: ["card-goal-1"], confidence: 0.85 }), [CARD], 3);
    expect(free.answered && free.answer.optionIndex).toBeNull();
  });
  it("puts the cards, instructions and question in the prompt as data", () => {
    const prompt = buildGeniusAnswerPrompt([CARD], [GOAL], BLOCKING);
    expect(prompt).toContain("card-goal-1");
    expect(prompt).toContain(JSON.stringify([GOAL]));
    expect(prompt).toContain(JSON.stringify(BLOCKING.options));
  });
  it("does not answer when claude fails", async () => {
    const judge = claudeGeniusAnswerJudge(async () => ({ ok: false, stdout: ANSWER_OK, stderr: "" }));
    expect((await judge([CARD], [GOAL], BLOCKING)).answered).toBe(false);
    const throws = claudeGeniusAnswerJudge(async () => { throw new Error("down"); });
    expect((await throws([CARD], [GOAL], BLOCKING)).answered).toBe(false);
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
  it("answers via Genius, marks the answer, and records the cards", async () => {
    const ctx = setup();
    expect(await ctx.guard.onQuestionPosted(posted())).toBe("answered");
    expect(ctx.judge).toHaveBeenCalledWith([CARD], [GOAL], BLOCKING);
    const text = (ctx.answer.mock.calls[0] as unknown[] | undefined)?.[2] as string;
    expect(text).toContain("[Genius 判断による Cc の自動回答]");
    expect(text).toContain("選択肢 1「Excubitor の信頼先に Amicii を足す」");
    expect(text).toContain("card-goal-1 (score 0.82)");
    expect(ctx.record).toHaveBeenCalledWith("s-1", expect.objectContaining({
      question_id: 7,
      answered_by: "genius",
      cards: [{ id: "card-goal-1", score: 0.82 }],
      option_index: 0,
    }));
  });
  it("leaves the question to the human when Genius cannot or should not judge", async () => {
    const cases: Array<[Parameters<typeof setup>[0], PostedQuestion]> = [
      [{ enabled: false }, posted()],
      [{ active: false }, posted()],
      [{}, posted({ kind: "plan_approval" })],
      [{}, posted({ hasParent: true })],
      [{ events: [inject(1, "auto:goal-and-go", "続けて")] }, posted()],
      [{ cards: null }, posted()],
      [{ cards: [] }, posted()],
      [{ cards: [{ ...CARD, tags: ["権限"] }] }, posted()],
      [{ verdict: "{}" }, posted()],
      [{}, posted({ question: "どちらの色を使いますか", options: ["赤", "青"] })],
    ];
    for (const [options, question] of cases) {
      const ctx = setup(options);
      expect(await ctx.guard.onQuestionPosted(question)).toBe("skipped");
      expect(ctx.answer).not.toHaveBeenCalled();
    }
  });
  it("does not ask the LLM when Genius has no precedent", async () => {
    const ctx = setup({ cards: [] });
    await ctx.guard.onQuestionPosted(posted());
    expect(ctx.judge).not.toHaveBeenCalled();
  });
  it("does nothing more when the human answered first", async () => {
    const ctx = setup({ answered: true });
    expect(await ctx.guard.onQuestionPosted(posted())).toBe("skipped");
    expect(ctx.record).not.toHaveBeenCalled();
  });
  it("formats a free-text answer without an option", () => {
    const text = goalStopAnswerText({ optionIndex: null, text: "上限 1 回で実行する", cardIds: ["card-goal-1"], confidence: 0.9 }, BLOCKING.options, [CARD]);
    expect(text).not.toContain("選択肢");
    expect(text).toContain("上限 1 回で実行する");
  });
  it("reads question.posted events (string and labelled options)", () => {
    const read = postedQuestionOf({ type: "question.posted", target_session_id: "s-1", question_id: 3, question: "q", options: ["a", { label: "b" }], parent_session_id: "p", ts: 1 });
    expect(read).toEqual({ sessionId: "s-1", questionId: 3, kind: "question", question: "q", options: ["a", "b"], hasParent: true });
    expect(postedQuestionOf({ type: "question.resolved", target_session_id: "s-1", question_id: 3, ts: 1 })).toBeNull();
  });
});
