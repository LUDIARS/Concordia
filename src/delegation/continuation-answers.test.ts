import { describe, expect, it, vi } from "vitest";
import { continuationAnswerContext } from "./continuation-answers.js";

type Run = Record<string, unknown>;
type Question = Record<string, unknown>;

function run(id: string, over: Run = {}): any {
  return {
    id,
    triggered_by: null,
    child_session_id: `sess-${id}`,
    parent_session_id: "parent",
    subsidiary_id: null,
    team_id: null,
    // created_at は ms、 質問の ts / answered_at は秒。
    created_at: 1_000_000,
    ...over,
  };
}

function question(id: number, sessionId: string, over: Question = {}): any {
  return {
    id,
    session_id: sessionId,
    question: `Q${id}`,
    answer_text: `A${id}`,
    answered_at: 2_000 + id,
    ts: 2_000 + id,
    ...over,
  };
}

function source(runs: any[], questions: any[]) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return {
    findRun: (id: string) => byId.get(id) ?? null,
    listAnsweredBySession: (sessionId: string, _limit: number) =>
      questions.filter((q) => q.session_id === sessionId),
  };
}

describe("continuationAnswerContext", () => {
  it("carries resolved answers from the whole partial-requeue chain, oldest first", () => {
    const root = run("root", { created_at: 1_000_000 });
    const current = run("current", { triggered_by: "partial-requeue:root", created_at: 3_000_000 });
    const text = continuationAnswerContext(
      current,
      source([root, current], [
        question(1, "sess-root", { ts: 1_500, answered_at: 1_500 }),
        question(2, "sess-current", { ts: 3_500, answered_at: 3_500 }),
      ]),
    );

    expect(text).toContain("同じ委託系列で確定済みの質問と回答");
    const ordered = JSON.parse(text.slice(text.indexOf("[")));
    expect(ordered.map((a: any) => a.question_id)).toEqual([1, 2]);
    expect(ordered[0]).toMatchObject({ run_id: "root", question: "Q1", answer: "A1" });
  });

  it("requests every answered question rather than the repository's display default", () => {
    const listAnsweredBySession = vi.fn(() => []);
    continuationAnswerContext(run("solo"), { findRun: () => null, listAnsweredBySession });

    expect(listAnsweredBySession).toHaveBeenCalledWith("sess-solo", -1);
  });

  it("returns an empty string when nothing was answered", () => {
    expect(continuationAnswerContext(run("solo"), source([], []))).toBe("");
  });

  it("drops unanswered, blank and locally resolved records", () => {
    const current = run("current");
    const text = continuationAnswerContext(
      current,
      source([current], [
        question(1, "sess-current", { answered_at: null }),
        question(2, "sess-current", { answer_text: "   " }),
        question(3, "sess-current", { answer_text: "(resolved locally)" }),
      ]),
    );

    expect(text).toBe("");
  });

  it("ignores questions raised before the owning run started", () => {
    const current = run("current", { created_at: 3_000_000 });
    const text = continuationAnswerContext(
      current,
      source([current], [question(1, "sess-current", { ts: 2_999, answered_at: 3_500 })]),
    );

    expect(text).toBe("");
  });

  it("bounds an ancestor's questions to the window before its successor started", () => {
    const root = run("root", { created_at: 1_000_000 });
    const current = run("current", { triggered_by: "partial-requeue:root", created_at: 2_000_000 });
    const text = continuationAnswerContext(
      current,
      source([root, current], [
        // root のセッションで、 次 run 開始後に付いた回答は継承しない。
        question(1, "sess-root", { ts: 2_500, answered_at: 2_500 }),
      ]),
    );

    expect(text).toBe("");
  });

  it("rejects an ancestry that leaves the run's owner scope", () => {
    const foreign = run("root", { parent_session_id: "other-parent" });
    const current = run("current", { triggered_by: "partial-requeue:root" });

    expect(() => continuationAnswerContext(current, source([foreign, current], [])))
      .toThrow(/outside the run owner scope/);
  });

  it("rejects a missing ancestor instead of silently dropping decisions", () => {
    const current = run("current", { triggered_by: "partial-requeue:gone" });

    expect(() => continuationAnswerContext(current, source([current], [])))
      .toThrow(/missing or outside the run owner scope/);
  });

  it("rejects cyclic ancestry", () => {
    const current = run("cycle", { triggered_by: "partial-requeue:cycle" });

    expect(() => continuationAnswerContext(current, source([current], [])))
      .toThrow(/invalid continuation answer ancestry/);
  });
});
