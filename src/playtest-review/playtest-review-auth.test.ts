import { describe, expect, it, vi } from "vitest";
import { decidePlaytestReviewAuth, readPlaytestIntakeToken, tokenMatches, type PlaytestIntakeToken } from "./playtest-review-auth.js";

const KEY = "k".repeat(40);
const set: PlaytestIntakeToken = { kind: "set", value: KEY };

describe("decidePlaytestReviewAuth (CC-PLAYTEST-INV-07)", () => {
  it("leaves the decision to the legacy check when the intake token is unset", () => {
    const legacy = vi.fn((header: string | undefined) => header === "shared");
    expect(decidePlaytestReviewAuth({ presented: "shared", intakeToken: { kind: "unset" }, legacy })).toEqual({ allowed: true });
    expect(decidePlaytestReviewAuth({ presented: undefined, intakeToken: { kind: "unset" }, legacy })).toEqual({ allowed: false, reason: "legacy_rejected" });
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it("keeps the loopback deployment open when nothing is configured", () => {
    expect(decidePlaytestReviewAuth({ presented: undefined, intakeToken: { kind: "unset" }, legacy: () => true })).toEqual({ allowed: true });
  });

  it("accepts only the intake token once it is set, and never consults the legacy check", () => {
    const legacy = vi.fn(() => true);
    expect(decidePlaytestReviewAuth({ presented: KEY, intakeToken: set, legacy })).toEqual({ allowed: true });
    expect(decidePlaytestReviewAuth({ presented: "x".repeat(40), intakeToken: set, legacy })).toEqual({ allowed: false, reason: "mismatch" });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty header as missing", () => {
    expect(decidePlaytestReviewAuth({ presented: undefined, intakeToken: set, legacy: () => true })).toEqual({ allowed: false, reason: "missing" });
    expect(decidePlaytestReviewAuth({ presented: "", intakeToken: set, legacy: () => true })).toEqual({ allowed: false, reason: "missing" });
  });

  it("rejects values of a different length, including prefixes of the key", () => {
    for (const presented of [KEY.slice(0, 39), `${KEY}k`, "k"]) {
      expect(decidePlaytestReviewAuth({ presented, intakeToken: set, legacy: () => true })).toEqual({ allowed: false, reason: "mismatch" });
    }
  });

  it("rejects everything when the stored token cannot be read, instead of falling back to the open legacy check", () => {
    const legacy = vi.fn(() => true);
    expect(decidePlaytestReviewAuth({ presented: KEY, intakeToken: { kind: "unreadable" }, legacy })).toEqual({ allowed: false, reason: "unreadable" });
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("tokenMatches", () => {
  it("compares in constant time without throwing on a length difference", () => {
    expect(tokenMatches(KEY, KEY)).toBe(true);
    expect(tokenMatches("short", KEY)).toBe(false);
    expect(tokenMatches("", KEY)).toBe(false);
  });
});

describe("readPlaytestIntakeToken", () => {
  it("maps the setting read to the token state", () => {
    expect(readPlaytestIntakeToken(() => null)).toEqual({ kind: "unset" });
    expect(readPlaytestIntakeToken(() => "")).toEqual({ kind: "unset" });
    expect(readPlaytestIntakeToken(() => KEY)).toEqual({ kind: "set", value: KEY });
    expect(readPlaytestIntakeToken(() => { throw new Error("cannot decrypt persisted setting"); })).toEqual({ kind: "unreadable" });
  });
});
