import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { makeDiscordPendingQuestionsRepo, type DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { answerPendingQuestion, questionStoreFromRepo } from "../control/answer-question.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { DirectorAskBridge, type AskBundleAnswer } from "./ask-bridge.js";
import { DirectorRepo } from "./repo.js";
import { DirectorService } from "./service.js";
import type { DirectorCase, DirectorStep } from "./types.js";

const SESSION_ID = "sess-ask-1";
const BUNDLE_DELAY_MS = 50;

interface Harness {
  db: Database.Database;
  repo: DirectorRepo;
  questions: DiscordPendingQuestionsRepo;
  service: DirectorService;
  bridge: DirectorAskBridge;
  onAnswered: ReturnType<typeof vi.fn>;
  posted: Array<Extract<ConcordiaEvent, { type: "question.posted" }>>;
  stops: Array<() => void>;
}

function makeHarness(): Harness {
  const db = new Database(":memory:");
  applyMigrations(db);
  const repo = new DirectorRepo(db);
  const questions = makeDiscordPendingQuestionsRepo(db);
  const onAnswered = vi.fn();
  // service ⇄ bridge は bootstrap と同じく相互参照 (onAskHuman → enqueue / unblockStep → updateStep)。
  const bridge: DirectorAskBridge = new DirectorAskBridge({
    repo,
    questions,
    bundleDelayMs: BUNDLE_DELAY_MS,
    now: () => 1_730_000_100,
    unblockStep: (caseId, stepId) => {
      try {
        service.updateStep({ case_id: caseId, step_id: stepId, status: "active" });
      } catch {
        // terminal step は監査のみ
      }
    },
    onAnswered: (directorCase, step, answers, resumed) => onAnswered(directorCase, step, answers, resumed),
  });
  const service = new DirectorService({
    repo,
    genius: { query: async () => null },
    scoreMin: 0.8,
    now: () => 1_730_000_000_000,
    onAskHuman: (directorCase, step, decision) => bridge.enqueue(directorCase, step, decision),
  });
  const posted: Harness["posted"] = [];
  const stops: Array<() => void> = [];
  stops.push(eventBus.subscribe((event) => {
    if (event.type === "question.posted") posted.push(event);
  }));
  const started = bridge.start();
  stops.push(() => started.stop());
  return { db, repo, questions, service, bridge, onAnswered, posted, stops };
}

async function requestAskHuman(
  h: Harness,
  input: { caseId: string; stepId: string; question: string; options: string[] },
): Promise<void> {
  await h.service.requestDecision({
    case_id: input.caseId,
    step_id: input.stepId,
    kind: "authority",
    question: input.question,
    facts: ["調査済みの事実"],
    options: input.options,
    impact: "作業の継続可否に影響",
  });
}

function makeBlockedCase(h: Harness): { directorCase: DirectorCase; step: DirectorStep } {
  const created = h.service.createCase({
    title: "goalgo改修",
    goal: "判断を人間へ上げる",
    project: "Cc",
    session_id: SESSION_ID,
    steps: [{ kind: "implement", title: "実装" }],
  });
  const step = h.service.updateStep({
    case_id: created.case.id,
    step_id: created.steps[0]!.id,
    status: "active",
  });
  return { directorCase: created.case, step };
}

describe("DirectorAskBridge", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeHarness();
  });

  afterEach(() => {
    for (const stop of h.stops) stop();
    vi.useRealTimers();
  });

  it("bundles multiple ask_human decisions into a single question card", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "push してよいか", options: ["push する", "待つ"] });
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "スコープを広げるか", options: ["広げる", "維持"] });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);

    expect(h.posted).toHaveLength(1);
    const card = h.questions.findById(h.posted[0]!.question_id)!;
    expect(card.session_id).toBe(SESSION_ID);
    expect(card.multi_select).toBe(1);
    expect(card.question).toContain("Q1. push してよいか");
    expect(card.question).toContain("Q2. スコープを広げるか");
    expect((JSON.parse(card.options_json) as Array<{ label: string }>).map((option) => option.label))
      .toEqual(["Q1: push する", "Q1: 待つ", "Q2: 広げる", "Q2: 維持"]);
    const decisions = h.repo.listDecisions(directorCase.id);
    expect(decisions).toHaveLength(2);
    for (const decision of decisions) expect(decision.pending_question_id).toBe(card.id);
  });

  it("posts a single-item card with plain options and no multi-select", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "push してよいか", options: ["push する", "待つ"] });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);

    const card = h.questions.findById(h.posted[0]!.question_id)!;
    expect(card.multi_select).toBe(0);
    expect((JSON.parse(card.options_json) as Array<{ label: string }>).map((option) => option.label))
      .toEqual(["push する", "待つ"]);
  });

  it("does not post a card for Genius-answered or plan-submitted decisions", async () => {
    const service = new DirectorService({
      repo: h.repo,
      genius: {
        query: async () => [{ id: "g1", title: "前例", score: 0.95, judgment: "push してよい" }],
      },
      scoreMin: 0.8,
      onAskHuman: (directorCase, step, decision) => h.bridge.enqueue(directorCase, step, decision),
    });
    const created = service.createCase({
      title: "goalgo改修", goal: "Genius 前例で進む", project: "Cc", session_id: SESSION_ID,
      steps: [{ kind: "plan", title: "プラン" }],
    });
    service.updateStep({ case_id: created.case.id, step_id: created.steps[0]!.id, status: "active" });
    const proceed = await service.requestDecision({
      case_id: created.case.id, step_id: created.steps[0]!.id, kind: "design",
      question: "push してよいか", facts: [], options: ["push する"], impact: "軽微",
    });
    expect(proceed.decision.decision).toBe("proceed");
    // plan 提出由来の ask_human は設計カード経路 (onAskHuman を通さない)。
    service.submitPlan({
      case_id: created.case.id, step_id: created.steps[0]!.id,
      markdown: "# plan\n## 受け入れ条件\n- green",
    });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);

    expect(h.posted).toHaveLength(0);
  });

  it("reflects a button answer into the decision and resumes the blocked step", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "push してよいか", options: ["push する", "待つ"] });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    const questionId = h.posted[0]!.question_id;

    const result = answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: questionId, answer_index: 1 },
    );
    expect(result.ok).toBe(true);

    const decision = h.repo.listDecisions(directorCase.id)[0]!;
    expect(decision.human_answer).toBe("待つ");
    expect(decision.human_answered_at).toBe(1_730_000_100);
    expect(h.service.getCase(directorCase.id)?.steps[0]?.status).toBe("active");
    expect(h.onAnswered).toHaveBeenCalledTimes(1);
    const answers = h.onAnswered.mock.calls[0]![2] as AskBundleAnswer[];
    expect(answers.map((entry) => entry.answer)).toEqual(["待つ"]);
  });

  it("maps multi-select answers back to each bundled decision", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "push してよいか", options: ["push する", "待つ"] });
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "スコープを広げるか", options: ["広げる", "維持"] });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    const questionId = h.posted[0]!.question_id;

    const result = answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: questionId, answer_indices: [1, 2] },
    );
    expect(result.ok).toBe(true);

    const decisions = h.repo.listDecisions(directorCase.id);
    expect(decisions.map((decision) => decision.human_answer)).toEqual(["待つ", "広げる"]);
    expect(h.service.getCase(directorCase.id)?.steps[0]?.status).toBe("active");
  });

  it("applies a free-text answer to every bundled decision", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "push してよいか", options: ["push する", "待つ"] });
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "スコープを広げるか", options: ["広げる", "維持"] });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    const questionId = h.posted[0]!.question_id;

    answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: questionId, other_text: "push は保留。スコープは維持で。" },
    );

    const decisions = h.repo.listDecisions(directorCase.id);
    expect(decisions.map((decision) => decision.human_answer))
      .toEqual(["push は保留。スコープは維持で。", "push は保留。スコープは維持で。"]);
  });

  it("keeps the step blocked until every overflow card is answered", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    const firstOptions = Array.from({ length: 13 }, (_, index) => `first-${index}`);
    const secondOptions = Array.from({ length: 13 }, (_, index) => `second-${index}`);
    await requestAskHuman(h, {
      caseId: directorCase.id, stepId: step.id, question: "最初の判断", options: firstOptions,
    });
    await requestAskHuman(h, {
      caseId: directorCase.id, stepId: step.id, question: "次の判断", options: secondOptions,
    });
    // 26 選択肢目で Discord の 25 件上限を超えるため、先行分は即時 flush される。
    expect(h.posted).toHaveLength(1);
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    expect(h.posted).toHaveLength(2);

    const firstResult = answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: h.posted[0]!.question_id, answer_index: 0 },
    );
    expect(firstResult.ok).toBe(true);
    expect(h.service.getCase(directorCase.id)?.steps[0]?.status).toBe("blocked");
    expect(h.onAnswered).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: directorCase.id }),
      expect.objectContaining({ id: step.id, status: "blocked" }),
      expect.any(Array),
      false,
    );

    const secondResult = answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: h.posted[1]!.question_id, answer_index: 0 },
    );
    expect(secondResult.ok).toBe(true);
    expect(h.service.getCase(directorCase.id)?.steps[0]?.status).toBe("active");
    expect(h.onAnswered).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: directorCase.id }),
      expect.objectContaining({ id: step.id, status: "active" }),
      expect.any(Array),
      true,
    );
  });

  it("recovers an unposted ask_human decision when the bridge restarts", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, {
      caseId: directorCase.id, stepId: step.id, question: "再起動後に投稿するか", options: ["投稿する", "待つ"],
    });
    // makeHarness で 2 番目に登録される bridge stop は未発火の束ね窓を破棄する。
    h.stops[1]!();
    const restarted = new DirectorAskBridge({
      repo: h.repo,
      questions: h.questions,
      bundleDelayMs: BUNDLE_DELAY_MS,
      now: () => 1_730_000_100,
      unblockStep: (caseId, stepId) => {
        h.service.updateStep({ case_id: caseId, step_id: stepId, status: "active" });
      },
      onAnswered: (foundCase, foundStep, answers, resumed) => h.onAnswered(foundCase, foundStep, answers, resumed),
    });
    const started = restarted.start();
    h.stops.push(() => started.stop());
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);

    expect(h.posted).toHaveLength(1);
    expect(h.repo.listDecisions(directorCase.id)[0]?.pending_question_id)
      .toBe(h.posted[0]!.question_id);
  });

  it("applies a persisted answer after restart when its event was missed", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, {
      caseId: directorCase.id, stepId: step.id, question: "回答反映前に停止したか", options: ["続行する", "待つ"],
    });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    const questionId = h.posted[0]!.question_id;
    h.stops[1]!();
    const answer = answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: questionId, answer_index: 0 },
    );
    expect(answer.ok).toBe(true);
    expect(h.repo.listDecisions(directorCase.id)[0]?.human_answer).toBeNull();

    const restarted = new DirectorAskBridge({
      repo: h.repo,
      questions: h.questions,
      bundleDelayMs: BUNDLE_DELAY_MS,
      now: () => 1_730_000_100,
      unblockStep: (caseId, stepId) => {
        h.service.updateStep({ case_id: caseId, step_id: stepId, status: "active" });
      },
      onAnswered: (foundCase, foundStep, answers, resumed) => h.onAnswered(foundCase, foundStep, answers, resumed),
    });
    const started = restarted.start();
    h.stops.push(() => started.stop());

    expect(h.repo.listDecisions(directorCase.id)[0]?.human_answer).toBe("続行する");
    expect(h.service.getCase(directorCase.id)?.steps[0]?.status).toBe("active");
    expect(h.onAnswered).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: directorCase.id }),
      expect.objectContaining({ id: step.id, status: "active" }),
      expect.any(Array),
      true,
    );
  });

  it("rejects an out-of-range answer index without touching the decision", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "push してよいか", options: ["push する", "待つ"] });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    const questionId = h.posted[0]!.question_id;

    const result = answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: questionId, answer_index: 99 },
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
    const decision = h.repo.listDecisions(directorCase.id)[0]!;
    expect(decision.human_answer).toBeNull();
    expect(h.service.getCase(directorCase.id)?.steps[0]?.status).toBe("blocked");
    expect(h.onAnswered).not.toHaveBeenCalled();
  });

  it("records a late answer without reopening or notifying a terminal step", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, {
      caseId: directorCase.id, stepId: step.id, question: "終了後も回答を記録するか", options: ["記録する", "破棄する"],
    });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    h.service.updateStep({ case_id: directorCase.id, step_id: step.id, status: "cancelled" });

    const result = answerPendingQuestion(
      { sessions: { findSession: () => ({}), appendEvent: () => {} }, questions: questionStoreFromRepo(h.questions) },
      SESSION_ID,
      { question_id: h.posted[0]!.question_id, answer_index: 0 },
    );

    expect(result.ok).toBe(true);
    expect(h.repo.listDecisions(directorCase.id)[0]?.human_answer).toBe("記録する");
    expect(h.service.getCase(directorCase.id)?.steps[0]?.status).toBe("cancelled");
    expect(h.onAnswered).not.toHaveBeenCalled();
  });

  it("ignores answers for unrelated questions and never overwrites the first answer", async () => {
    const { directorCase, step } = makeBlockedCase(h);
    await requestAskHuman(h, { caseId: directorCase.id, stepId: step.id, question: "push してよいか", options: ["push する", "待つ"] });
    vi.advanceTimersByTime(BUNDLE_DELAY_MS + 10);
    const questionId = h.posted[0]!.question_id;

    eventBus.emit({
      type: "question.answered", target_session_id: SESSION_ID,
      question_id: questionId + 999, answer_index: 0, answer_text: "無関係", ts: 1,
    });
    expect(h.repo.listDecisions(directorCase.id)[0]!.human_answer).toBeNull();

    eventBus.emit({
      type: "question.answered", target_session_id: SESSION_ID,
      question_id: questionId, answer_index: 0, answer_text: "未確定イベント", ts: 1,
    });
    expect(h.repo.listDecisions(directorCase.id)[0]!.human_answer).toBeNull();

    h.questions.markAnswered(questionId, 0, "push する");
    eventBus.emit({
      type: "question.answered", target_session_id: "another-session",
      question_id: questionId, answer_index: 0, answer_text: "push する", ts: 1,
    });
    expect(h.repo.listDecisions(directorCase.id)[0]!.human_answer).toBeNull();

    eventBus.emit({
      type: "question.answered", target_session_id: SESSION_ID,
      question_id: questionId, answer_index: 0, answer_text: "push する", ts: 1,
    });
    eventBus.emit({
      type: "question.answered", target_session_id: SESSION_ID,
      question_id: questionId, answer_index: 1, answer_text: "待つ", ts: 2,
    });

    expect(h.repo.listDecisions(directorCase.id)[0]!.human_answer).toBe("push する");
    expect(h.onAnswered).toHaveBeenCalledTimes(1);
  });
});
