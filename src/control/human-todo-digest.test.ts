import { describe, expect, it } from "vitest";
import {
  HUMAN_TODO_LIST_LIMIT,
  HUMAN_TODO_REPORT_KEY,
  collectHumanTodos,
  decideHumanTodoReport,
  humanTodoDigest,
  readHumanTodoReport,
  renderHumanTodoReport,
} from "./human-todo-digest.js";

const wait = (summary: string, refs: string[] = []) => ({ active: true, summary, task_references: refs, since: 1 });

describe("人間のやることの集約", () => {
  it("判断待ちを先頭に、質問は古い順に並べ、空の項目は捨てる", () => {
    const items = collectHumanTodos({
      humanWait: wait("VANMAC の担当を決める", ["actio:b", "actio:a", "actio:b"]),
      questions: [{ id: 9, question: "後の質問" }, { id: 3, question: "先の質問" }, { id: 5, question: "   " }],
    });
    expect(items).toEqual([
      { kind: "human_wait", text: "VANMAC の担当を決める", references: ["actio:a", "actio:b"] },
      { kind: "question", text: "先の質問", references: [] },
      { kind: "question", text: "後の質問", references: [] },
    ]);
  });

  it("長い本文は 1 項目 300 字に切り、改行は空白にまとめる", () => {
    const [item] = collectHumanTodos({ humanWait: null, questions: [{ id: 1, question: `a\n${"x".repeat(400)}` }] });
    expect(item!.text).toHaveLength(300);
    expect(item!.text.startsWith("a x")).toBe(true);
    expect(item!.text.endsWith("…")).toBe(true);
  });

  it("要約値は内容だけで決まり、時刻や human-wait の開始時刻では変わらない", () => {
    const a = collectHumanTodos({ humanWait: { ...wait("同じ"), since: 1 }, questions: [] });
    const b = collectHumanTodos({ humanWait: { ...wait("同じ"), since: 999 }, questions: [] });
    const c = collectHumanTodos({ humanWait: wait("違う"), questions: [] });
    expect(humanTodoDigest(a)).toBe(humanTodoDigest(b));
    expect(humanTodoDigest(a)).not.toBe(humanTodoDigest(c));
  });
});

describe("報告要否の判定", () => {
  const items = collectHumanTodos({ humanWait: wait("判断"), questions: [] });
  const digest = humanTodoDigest(items);

  it("初回と内容変更時だけ report、同じなら unchanged", () => {
    expect(decideHumanTodoReport({ items, last: null })).toEqual({ kind: "report", digest });
    expect(decideHumanTodoReport({ items, last: { digest, count: 1, reported_at: 1 } })).toEqual({ kind: "unchanged" });
    expect(decideHumanTodoReport({ items, last: { digest: "old", count: 1, reported_at: 1 } })).toEqual({ kind: "report", digest });
  });

  it("項目が無くなったら、前回報告があるときだけ resolved", () => {
    expect(decideHumanTodoReport({ items: [], last: { digest, count: 1, reported_at: 1 } })).toEqual({ kind: "resolved" });
    expect(decideHumanTodoReport({ items: [], last: null })).toEqual({ kind: "none" });
  });

  it("記録の読み出しは壊れた値を null にする", () => {
    expect(readHumanTodoReport(JSON.stringify({ [HUMAN_TODO_REPORT_KEY]: { digest, count: 1, reported_at: 2 } })))
      .toEqual({ digest, count: 1, reported_at: 2 });
    expect(readHumanTodoReport(JSON.stringify({ [HUMAN_TODO_REPORT_KEY]: { digest: "" , count: 1, reported_at: 2 } }))).toBeNull();
    expect(readHumanTodoReport("not json")).toBeNull();
    expect(readHumanTodoReport(null)).toBeNull();
  });
});

describe("報告本文", () => {
  it("種別・参照を添え、上限を超えた分は件数だけ示す", () => {
    const questions = Array.from({ length: HUMAN_TODO_LIST_LIMIT + 2 }, (_, i) => ({ id: i + 1, question: `質問${i + 1}` }));
    const text = renderHumanTodoReport(collectHumanTodos({ humanWait: wait("判断", ["actio:t1"]), questions }));
    expect(text).toContain(`(${HUMAN_TODO_LIST_LIMIT + 3} 件)`);
    expect(text).toContain("1. [判断待ち] 判断 (actio:t1)");
    expect(text).toContain("2. [未回答の質問] 質問1");
    expect(text).toContain("ほか 3 件");
    expect(text).toContain("自動確認は続けます");
  });
});
