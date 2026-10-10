import { describe, expect, it } from "vitest";
import { canHumanStop, evaluateExhausted, evaluateGoalReached } from "./stop-policy.js";

describe("evaluateGoalReached (CC-DG-INV-03)", () => {
  it("reaches only when every acceptance item has verified evidence", () => {
    expect(evaluateGoalReached(["A", "B"], new Map([["A", ["pr:x#1:merged"]], ["B", ["actio:t:done"]]]))).toEqual({ reached: true });
    expect(evaluateGoalReached(["A", "B"], new Map([["A", ["pr:x#1:merged"]], ["B", []]]))).toEqual({ reached: false, missing: ["B"] });
  });
  it("does not reach on self-report alone or with no acceptance items", () => {
    expect(evaluateGoalReached(["A"], new Map())).toEqual({ reached: false, missing: ["A"] });
    expect(evaluateGoalReached([], new Map())).toEqual({ reached: false, missing: [] });
  });
});

describe("evaluateExhausted (受け入れ基準: AI だけで進められる残りが 1 件でもあれば認めない)", () => {
  const exists = () => true;
  it("rejects when any doable item remains", () => {
    expect(evaluateExhausted([
      { item: "A", class: "unachievable", reason: "外部 API が無い" },
      { item: "B", class: "doable" },
    ], exists)).toEqual({ accepted: false, reason: "doable_remaining", doable: ["B"] });
  });
  it("accepts reasoned unachievable items and existing human judgments", () => {
    expect(evaluateExhausted([
      { item: "A", class: "unachievable", reason: "権限が無い" },
      { item: "B", class: "human_judgment", questionId: 12 },
      { item: "C", class: "human_judgment", humanWait: true },
    ], exists)).toEqual({ accepted: true });
  });
  it("rejects missing reasons, unlinked or non-existing human judgments, and empty lists", () => {
    expect(evaluateExhausted([{ item: "A", class: "unachievable", reason: " " }], exists).accepted).toBe(false);
    expect(evaluateExhausted([{ item: "B", class: "human_judgment" }], exists).accepted).toBe(false);
    expect(evaluateExhausted([{ item: "B", class: "human_judgment", questionId: 1 }], () => false).accepted).toBe(false);
    expect(evaluateExhausted([], exists).accepted).toBe(false);
  });
});

describe("canHumanStop", () => {
  it("allows the confirmer or a session_control holder, never a non-human", () => {
    expect(canHumanStop({ isHuman: true, isConfirmer: true, hasSessionControl: false })).toBe(true);
    expect(canHumanStop({ isHuman: true, isConfirmer: false, hasSessionControl: true })).toBe(true);
    expect(canHumanStop({ isHuman: true, isConfirmer: false, hasSessionControl: false })).toBe(false);
    expect(canHumanStop({ isHuman: false, isConfirmer: true, hasSessionControl: true })).toBe(false);
  });
});
