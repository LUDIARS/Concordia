import { describe, expect, it } from "vitest";
import {
  escalateQuestionToHuman,
  makeQuestionEscalationDeps,
  sweepStaleParentQuestions,
  type EscalatableQuestionRow,
  type EscalateDeps,
} from "./question-escalation.js";
import { eventBus } from "../events.js";
import type { SessionEventRow } from "../shared/types.js";

/**
 * 委託子の質問は一次受けを親 (委託元) にする (問題ログ
 * 2026-09-05-delegation-question-relay-bypassed)。 親と人間へ同時配信していたため、
 * 先に答えた方が確定して、 リレー本文の指示どおり回答した親が already_answered で
 * 弾かれていた。
 *
 * 親一次受けにすると今度は 「親が裁かないと誰も気付かない」 穴が開くので、
 * 明示エスカレーションと猶予切れの自動エスカレーションを対で持つ。
 */

const ROW: EscalatableQuestionRow = {
  id: 42,
  session_id: "lictor-child",
  question: "どちらで進めますか",
  options: [{ label: "案A" }, { label: "案B" }],
  parent_session_id: "lictor-parent",
};

function makeDeps(over: Partial<EscalateDeps> = {}): {
  deps: EscalateDeps;
  events: Array<{ session_id: string; kind: string; payload: unknown }>;
  escalatedIds: number[];
} {
  const events: Array<{ session_id: string; kind: string; payload: unknown }> = [];
  const escalatedIds: number[] = [];
  const deps: EscalateDeps = {
    repo: {
      recentEvents: () => [] as SessionEventRow[],
      appendEvent: (e) => events.push({ session_id: e.session_id, kind: e.kind, payload: e.payload }),
    },
    questions: {
      markEscalated: (id) => {
        // 実装と同じく「未回答かつ未エスカレーションのときだけ true」を模す。
        if (escalatedIds.includes(id)) return false;
        escalatedIds.push(id);
        return true;
      },
    },
    now: () => 1_000,
    ...over,
  };
  return { deps, events, escalatedIds };
}

function captureQuestionPosted(run: () => void): unknown[] {
  const posted: unknown[] = [];
  const unsub = eventBus.subscribe((ev) => {
    if ((ev as { type?: string }).type === "question.posted") posted.push(ev);
  });
  try {
    run();
  } finally {
    unsub();
  }
  return posted;
}

describe("escalateQuestionToHuman", () => {
  it("元の question 行のまま人間へ配信する", () => {
    // 親に ask マーカーで聞き直させると、子の質問と人間の回答が別 id になり結び付かない。
    const { deps, events } = makeDeps();
    const posted = captureQuestionPosted(() => {
      expect(escalateQuestionToHuman(deps, ROW, null)).toBe(true);
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "question.posted",
      target_session_id: "lictor-child",
      question_id: 42,
      question: "どちらで進めますか",
      parent_session_id: "lictor-parent",
    });
    expect(events).toEqual([
      {
        session_id: "lictor-child",
        kind: "question_escalated",
        payload: { question_id: 42, parent_session_id: "lictor-parent", note: null },
      },
    ]);
  });

  it("note があれば本文に足す (人間は委託の文脈を知らない)", () => {
    const { deps } = makeDeps();
    const posted = captureQuestionPosted(() => {
      escalateQuestionToHuman(deps, ROW, "  どちらも仕様上ありうる  ");
    });
    expect(posted[0]).toMatchObject({
      question: "どちらで進めますか\n\n(委託元より) どちらも仕様上ありうる",
    });
  });

  it("複数選択の質問は multi_select を保って配信する", () => {
    // 落とすと単一選択のカードが人間に出て、子が求めた形の回答を返せなくなる。
    const { deps } = makeDeps();
    const posted = captureQuestionPosted(() => {
      escalateQuestionToHuman(deps, { ...ROW, multi_select: true }, null);
    });
    expect(posted[0]).toMatchObject({ multi_select: true });
  });

  it("multi_select が無い行は単一選択として配信する", () => {
    const { deps } = makeDeps();
    const posted = captureQuestionPosted(() => {
      escalateQuestionToHuman(deps, ROW, null);
    });
    expect(posted[0]).toMatchObject({ multi_select: false });
  });

  it("二重エスカレーションは配信しない", () => {
    // 明示エスカレーションと自動エスカレーションが同時に来てもカードは 1 枚。
    const { deps } = makeDeps();
    const posted = captureQuestionPosted(() => {
      expect(escalateQuestionToHuman(deps, ROW, null)).toBe(true);
      expect(escalateQuestionToHuman(deps, ROW, null)).toBe(false);
    });
    expect(posted).toHaveLength(1);
  });
});

describe("sweepStaleParentQuestions", () => {
  it("猶予を過ぎた質問だけを人間へ上げる", () => {
    const seen: number[] = [];
    const escalated = sweepStaleParentQuestions({
      listStale: (olderThanTs) => {
        seen.push(olderThanTs);
        return [ROW];
      },
      escalate: () => true,
      graceSec: () => 300,
      now: () => 10_000,
    });
    expect(escalated).toBe(1);
    // 「今 - 猶予」より前に作られた質問を引く。
    expect(seen).toEqual([9_700]);
  });

  it("猶予 0 以下なら何もしない (親一次受けを無効化しない)", () => {
    let called = false;
    const escalated = sweepStaleParentQuestions({
      listStale: () => {
        called = true;
        return [ROW];
      },
      escalate: () => true,
      graceSec: () => 0,
      now: () => 10_000,
    });
    expect(escalated).toBe(0);
    expect(called).toBe(false);
  });

  it("1 件が失敗しても残りを止めない", () => {
    const second = { ...ROW, id: 43 };
    const escalated = sweepStaleParentQuestions({
      listStale: () => [ROW, second],
      escalate: (row) => {
        if (row.id === 42) throw new Error("boom");
        return true;
      },
      graceSec: () => 300,
      now: () => 10_000,
    });
    expect(escalated).toBe(1);
  });

  it("既に上げてある行は件数に数えない", () => {
    const escalated = sweepStaleParentQuestions({
      listStale: () => [ROW],
      escalate: () => false,
      graceSec: () => 300,
      now: () => 10_000,
    });
    expect(escalated).toBe(0);
  });
});

describe("makeQuestionEscalationDeps", () => {
  it("DB 行 (options_json / multi_select=1) を配信で使う形へ正規化する", () => {
    // 配線は bootstrap ではなくこの層が持つ。正規化を落とすと人間向けカードの
    // 選択肢が空になったり、複数選択が単一選択に化ける。
    const deps = makeQuestionEscalationDeps({
      repo: {
        recentEvents: () => [],
        appendEvent: () => {},
      },
      pendingQuestions: {
        markEscalated: () => true,
        listStaleParentRelayed: () => [
          {
            id: 7,
            session_id: "child",
            question: "Q",
            options_json: JSON.stringify([{ label: "案A" }]),
            parent_session_id: "parent",
            multi_select: 1,
          },
        ],
      },
      parseOptions: (json) => JSON.parse(json) as Array<{ label: string }>,
      graceSec: () => 300,
    });
    expect(deps.listStale(0, 10)).toEqual([
      {
        id: 7,
        session_id: "child",
        question: "Q",
        options: [{ label: "案A" }],
        parent_session_id: "parent",
        multi_select: true,
      },
    ]);
  });
});
