import { describe, expect, it, vi } from "vitest";
import type { SessionEventRow } from "../shared/types.js";
import { buildSummaryEventExcerpt } from "./summary-event-excerpt.js";

function eventRow(
  id: number,
  kind: string,
  payload: object,
  ts = id,
): SessionEventRow {
  return {
    id,
    session_id: "session-1",
    ts,
    kind,
    payload: JSON.stringify(payload),
  };
}

describe("buildSummaryEventExcerpt", () => {
  it("回答済み pending question を完了証跡へ置き換える", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "pending_question", {
          question_id: 1190,
          question: "PRを両方マージしますか?",
        }, 100),
        eventRow(2, "question_answered", {
          question_id: 1190,
          answer_index: 0,
          answer_text: "両方マージ",
        }, 150),
        eventRow(3, "task_update", { status: "done" }, 200),
      ],
      { referenceTimeSeconds: 300 },
    );

    expect(excerpt).toEqual([
      {
        kind: "task_update",
        ago_sec: 100,
        payload: { status: "done" },
      },
      {
        kind: "question_completed",
        ago_sec: 150,
        payload: {
          question_id: "1190",
          status: "answered",
          source: "event",
        },
      },
    ]);
  });

  it("ローカル解決済み pending question も完了証跡へ置き換える", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "pending_question", { question_id: 42 }, 100),
        eventRow(2, "question_resolved", { question_id: 42 }, 150),
      ],
      { referenceTimeSeconds: 300 },
    );

    expect(excerpt).toEqual([
      {
        kind: "question_completed",
        ago_sec: 150,
        payload: {
          question_id: "42",
          status: "resolved",
          source: "event",
        },
      },
    ]);
  });

  it("未回答の pending question は要約入力へ残す", () => {
    const excerpt = buildSummaryEventExcerpt(
      [eventRow(1, "pending_question", { question_id: 43 }, 100)],
      { referenceTimeSeconds: 300 },
    );

    expect(excerpt).toEqual([
      {
        kind: "pending_question",
        ago_sec: 200,
        payload: { question_id: 43 },
      },
    ]);
  });

  it("正本行が回答済みなら completion event 欠落時も完了扱いにする", () => {
    const findById = vi.fn((id: number) => (
      id === 44 ? { session_id: "session-1", answered_at: 180 } : null
    ));
    const excerpt = buildSummaryEventExcerpt(
      [eventRow(1, "pending_question", { question_id: 44 }, 100)],
      {
        referenceTimeSeconds: 300,
        questionState: { findById },
      },
    );

    expect(findById).toHaveBeenCalledWith(44);
    expect(excerpt).toEqual([
      {
        kind: "question_completed",
        ago_sec: 120,
        payload: {
          question_id: "44",
          status: "completed",
          source: "question_state",
        },
      },
    ]);
  });

  it("古い未回答文言より後ろに完了証跡を置く", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "prompt", { text: "質問 #45 はまだ未回答" }, 100),
        eventRow(2, "pending_question", { question_id: 45 }, 110),
        eventRow(3, "question_answered", {
          question_id: 45,
          answer_text: "承認",
        }, 120),
      ],
      { referenceTimeSeconds: 300 },
    );

    expect(excerpt[0]).toMatchObject({ kind: "prompt" });
    expect(excerpt.at(-1)).toMatchObject({
      kind: "question_completed",
      payload: { question_id: "45", status: "answered" },
    });
  });

  it("正本が未回答なら completion event があっても pending を残す", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "pending_question", { question_id: 50 }, 100),
        eventRow(2, "question_answered", { question_id: 50 }, 110),
      ],
      {
        referenceTimeSeconds: 300,
        questionState: {
          findById: () => ({ session_id: "session-1", answered_at: null }),
        },
      },
    );

    expect(excerpt).toEqual([
      {
        kind: "pending_question",
        ago_sec: 200,
        payload: { question_id: 50 },
      },
    ]);
  });

  it("別 session の正本行では pending を完了扱いにしない", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "pending_question", { question_id: 51 }, 100),
        eventRow(2, "question_answered", { question_id: 51 }, 110),
      ],
      {
        referenceTimeSeconds: 300,
        questionState: {
          findById: () => ({ session_id: "other-session", answered_at: 120 }),
        },
      },
    );

    expect(excerpt.map((entry) => entry.kind)).toEqual(["pending_question"]);
  });

  it("回答済みと未回答が混在しても未回答だけ pending として残す", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "pending_question", { question_id: 46 }, 100),
        eventRow(2, "pending_question", { question_id: 47 }, 110),
        eventRow(3, "question_answered", { question_id: 46 }, 120),
      ],
      { referenceTimeSeconds: 300 },
    );

    expect(excerpt.map((entry) => entry.kind)).toEqual([
      "pending_question",
      "question_completed",
    ]);
    expect(excerpt[0]?.payload).toEqual({ question_id: 47 });
    expect(excerpt[1]?.payload).toMatchObject({ question_id: "46" });
  });

  it("60件境界より古い completion event も全履歴から照合する", () => {
    const events = [
      eventRow(1, "pending_question", { question_id: 48 }, 1),
      eventRow(2, "question_answered", { question_id: 48 }, 2),
      ...Array.from({ length: 70 }, (_, index) => (
        eventRow(index + 3, "task_update", { index }, index + 3)
      )),
    ];
    const excerpt = buildSummaryEventExcerpt(events, {
      referenceTimeSeconds: 100,
      maxEvents: 60,
    });

    expect(excerpt).toHaveLength(61);
    expect(excerpt.some((entry) => entry.kind === "pending_question")).toBe(false);
    expect(excerpt.at(-1)).toMatchObject({
      kind: "question_completed",
      payload: { question_id: "48" },
    });
  });

  it("同一 ts は event id で安定整列して末尾を選ぶ", () => {
    const events = Array.from({ length: 61 }, (_, index) => (
      eventRow(index + 1, "task_update", { index }, 100)
    )).reverse();
    const excerpt = buildSummaryEventExcerpt(events, {
      referenceTimeSeconds: 200,
      maxEvents: 60,
    });

    expect(excerpt[0]?.payload).toEqual({ index: 1 });
    expect(excerpt.at(-1)?.payload).toEqual({ index: 60 });
  });

  it("completion が pending より前でも照合し number/string ID を同一視する", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "question_answered", { question_id: "0049" }, 100),
        eventRow(2, "pending_question", { question_id: 49 }, 110),
      ],
      { referenceTimeSeconds: 300 },
    );

    expect(excerpt).toEqual([
      {
        kind: "question_completed",
        ago_sec: 200,
        payload: {
          question_id: "49",
          status: "answered",
          source: "event",
        },
      },
    ]);
  });

  it("完了質問が60件あっても blocker と未回答質問の枠を消費しない", () => {
    const events = Array.from({ length: 60 }, (_, index) => {
      const questionId = index + 1;
      return [
        eventRow(questionId * 2 - 1, "pending_question", { question_id: questionId }, 100),
        eventRow(questionId * 2, "question_answered", { question_id: questionId }, 101),
      ];
    }).flat();
    events.push(eventRow(121, "lost", { reason: "current blocker" }, 200));
    events.push(eventRow(122, "pending_question", { question_id: 999 }, 201));

    const excerpt = buildSummaryEventExcerpt(events, {
      referenceTimeSeconds: 300,
    });

    expect(excerpt).toHaveLength(62);
    expect(excerpt[0]).toEqual({
      kind: "lost",
      ago_sec: 100,
      payload: { reason: "current blocker" },
    });
    expect(excerpt[1]).toEqual({
      kind: "pending_question",
      ago_sec: 99,
      payload: { question_id: 999 },
    });
    expect(excerpt.filter((entry) => entry.kind === "question_completed")).toHaveLength(60);
  });

  it("完了marker上限0ではmarkerだけを省き通常イベントを保持する", () => {
    const excerpt = buildSummaryEventExcerpt(
      [
        eventRow(1, "pending_question", { question_id: 1000 }, 100),
        eventRow(2, "question_answered", { question_id: 1000 }, 110),
        eventRow(3, "task_update", { status: "done" }, 120),
      ],
      {
        referenceTimeSeconds: 300,
        maxCompletedQuestions: 0,
      },
    );

    expect(excerpt).toEqual([
      {
        kind: "task_update",
        ago_sec: 180,
        payload: { status: "done" },
      },
    ]);
  });
});
