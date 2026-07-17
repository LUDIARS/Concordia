import { describe, expect, it } from "vitest";
import {
  answerPendingQuestion,
  type AnswerQuestionDeps,
  type AnswerQuestionStore,
} from "./answer-question.js";
import { eventBus } from "../events.js";

const SESSION = "lictor-test-session";

function makeDeps(rowOverrides: Partial<ReturnType<AnswerQuestionStore["findById"]>> = {}): {
  deps: AnswerQuestionDeps;
  calls: { marked: unknown[]; events: unknown[] };
} {
  const row = {
    id: 42,
    session_id: SESSION,
    options: [{ label: "案A" }, { label: "案B" }, { label: "案C" }],
    answered_at: null as number | null,
    ...rowOverrides,
  };
  const calls = { marked: [] as unknown[], events: [] as unknown[] };
  const deps: AnswerQuestionDeps = {
    sessions: {
      findSession: (id) => (id === SESSION ? { id } : null),
      appendEvent: (e) => calls.events.push(e),
    },
    questions: {
      findById: (id) => (id === row.id ? row : null),
      markAnswered: (...a) => calls.marked.push(["single", ...a]),
      markAnsweredMulti: (...a) => calls.marked.push(["multi", ...a]),
      markAnsweredOther: (...a) => calls.marked.push(["other", ...a]),
    },
    now: () => 1_000,
  };
  return { deps, calls };
}

describe("answerPendingQuestion", () => {
  it("単一選択: label を確定し question.answered を emit する", () => {
    const { deps, calls } = makeDeps();
    const emitted: unknown[] = [];
    const unsub = eventBus.subscribe((ev) => {
      if ((ev as { type?: string }).type === "question.answered") emitted.push(ev);
    });
    try {
      const r = answerPendingQuestion(deps, SESSION, { question_id: 42, answer_index: 1 });
      expect(r).toEqual({ ok: true, answer_text: "案B" });
      expect(calls.marked).toEqual([["single", 42, 1, "案B"]]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ question_id: 42, answer_index: 1, answer_text: "案B" });
      expect(calls.events).toHaveLength(1);
    } finally {
      unsub();
    }
  });

  it("複数選択: labels を ', ' 結合する", () => {
    const { deps, calls } = makeDeps();
    const r = answerPendingQuestion(deps, SESSION, { question_id: 42, answer_indices: [0, 2] });
    expect(r).toEqual({ ok: true, answer_text: "案A, 案C" });
    expect(calls.marked).toEqual([["multi", 42, [0, 2], "案A, 案C"]]);
  });

  it("自由文: other_text をそのまま使う (index は -1)", () => {
    const { deps, calls } = makeDeps();
    const r = answerPendingQuestion(deps, SESSION, { question_id: 42, other_text: "自由回答です" });
    expect(r).toEqual({ ok: true, answer_text: "自由回答です" });
    expect(calls.marked).toEqual([["other", 42, "自由回答です"]]);
    expect(calls.events[0]).toMatchObject({ payload: { answer_index: -1 } });
  });

  it("範囲外 index は 400", () => {
    const { deps } = makeDeps();
    expect(answerPendingQuestion(deps, SESSION, { question_id: 42, answer_index: 9 })).toEqual({
      ok: false,
      status: 400,
      error: "answer_index_out_of_range",
    });
    expect(answerPendingQuestion(deps, SESSION, { question_id: 42, answer_indices: [0, 9] })).toEqual({
      ok: false,
      status: 400,
      error: "answer_index_out_of_range",
    });
    expect(answerPendingQuestion(deps, SESSION, { question_id: 42, answer_indices: [] })).toEqual({
      ok: false,
      status: 400,
      error: "answer_index_out_of_range",
    });
  });

  it("回答済みは 409", () => {
    const { deps } = makeDeps({ answered_at: 999 });
    expect(answerPendingQuestion(deps, SESSION, { question_id: 42, answer_index: 0 })).toEqual({
      ok: false,
      status: 409,
      error: "already_answered",
    });
  });

  it("question / session 不一致は 404", () => {
    const { deps } = makeDeps();
    expect(answerPendingQuestion(deps, SESSION, { question_id: 7, answer_index: 0 })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(answerPendingQuestion(deps, "other-session", { question_id: 42, answer_index: 0 })).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});
