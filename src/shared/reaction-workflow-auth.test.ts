import { describe, expect, it } from "vitest";
import {
  isReactionUserAllowed,
  normalizeReactionUserIds,
  parseReactionUserAllowlist,
} from "./reaction-workflow-auth.js";

describe("reaction workflow user allowlist", () => {
  it("parses comma, semicolon, and whitespace separated IDs", () => {
    expect([...parseReactionUserAllowlist("u1, u2;u3\nu4")]).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("denies all users when the allowlist is empty", () => {
    expect(isReactionUserAllowed(undefined, "u1")).toBe(false);
    expect(isReactionUserAllowed("", "u1")).toBe(false);
  });

  it("allows only exact user IDs", () => {
    expect(isReactionUserAllowed("u1,u2", "u2")).toBe(true);
    expect(isReactionUserAllowed("u1,u2", "u20")).toBe(false);
  });

  it("normalizes persisted ID arrays and removes duplicates", () => {
    expect(normalizeReactionUserIds([" u1 ", "u2", "u1"])).toEqual(["u1", "u2"]);
    expect(isReactionUserAllowed(["u1", "u2"], "u2")).toBe(true);
    expect(isReactionUserAllowed(["u1", "u2"], "U2")).toBe(false);
  });
});
