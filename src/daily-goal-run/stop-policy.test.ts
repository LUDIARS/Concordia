import { describe, expect, it } from "vitest";
import { canHumanStop, evaluateGoalReached, STOP_CONDITIONS } from "./stop-policy.js";

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

describe("canHumanStop", () => {
  it("allows the confirmer or a session_control holder, never a non-human", () => {
    expect(canHumanStop({ isHuman: true, isConfirmer: true, hasSessionControl: false })).toBe(true);
    expect(canHumanStop({ isHuman: true, isConfirmer: false, hasSessionControl: true })).toBe(true);
    expect(canHumanStop({ isHuman: true, isConfirmer: false, hasSessionControl: false })).toBe(false);
    expect(canHumanStop({ isHuman: false, isConfirmer: true, hasSessionControl: true })).toBe(false);
  });
});

describe("STOP_CONDITIONS (CC-DG-INV-05)", () => {
  it("has exactly three stop conditions including the deadline, and no exhausted, stagnation or midnight condition", () => {
    expect([...STOP_CONDITIONS]).toEqual(["goal_reached", "human_stop", "deadline"]);
  });
});
