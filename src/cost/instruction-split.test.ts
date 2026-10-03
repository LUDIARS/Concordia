import { describe, expect, it } from "vitest";
import { splitByInstructionCount, turnSegments } from "./instruction-split.js";

describe("turnSegments", () => {
  it("AI の最終回答ごとに区間を切り、 区間の時刻に入る指示をその区間に入れる", () => {
    const segments = turnSegments(
      [
        { atMs: 2_000, tokens: 10 },
        { atMs: 3_000, tokens: 20, turnEnd: true },
        { atMs: 6_000, tokens: 5, turnEnd: true },
        { atMs: 9_000, tokens: 7 },
      ],
      [{ atMs: 1_000, userId: "a" }, { atMs: 2_500, userId: "b" }, { atMs: 8_000, userId: "a" }],
    );
    expect(segments).toEqual([
      { tokens: 30, instructedBy: ["a", "b"] },
      { tokens: 5, instructedBy: [] },
      { tokens: 7, instructedBy: ["a"] },
    ]);
  });

  it("最終回答の印が無ければセッション全体を 1 区間にする", () => {
    expect(turnSegments([{ atMs: 2_000, tokens: 10 }], [{ atMs: 1_000, userId: "a" }]))
      .toEqual([{ tokens: 10, instructedBy: ["a"] }]);
  });

  it("消費 0 の最終回答 (Codex の task_complete) でも区間を切る", () => {
    expect(turnSegments(
      [{ atMs: 1_500, tokens: 40 }, { atMs: 2_000, tokens: 0, turnEnd: true }, { atMs: 4_000, tokens: 9 }],
      [{ atMs: 1_000, userId: "a" }, { atMs: 3_000, userId: "b" }],
    )).toEqual([{ tokens: 40, instructedBy: ["a"] }, { tokens: 9, instructedBy: ["b"] }]);
  });
});

describe("splitByInstructionCount", () => {
  it("指示の回数で按分する (A 2 回・B 1 回 → 2/3 と 1/3)", () => {
    expect(splitByInstructionCount(900, ["a", "b", "a"])).toEqual([
      { userId: "a", tokens: 600 },
      { userId: "b", tokens: 300 },
    ]);
  });

  it("1 人なら全額、 指示が無い・消費が無いなら空", () => {
    expect(splitByInstructionCount(50, ["a", "a"])).toEqual([{ userId: "a", tokens: 50 }]);
    expect(splitByInstructionCount(50, [])).toEqual([]);
    expect(splitByInstructionCount(0, ["a"])).toEqual([]);
  });
});
