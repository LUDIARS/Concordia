import { describe, expect, it } from "vitest";
import { canChooseChore, parseChoreMessage, validateChoreInput } from "./domain.js";
describe("chore policy", () => {
  it("defaults to Claude and parses an explicit Codex request", () => {
    expect(parseChoreMessage("整理して")).toEqual({ provider: "claude", prompt: "整理して" });
    expect(parseChoreMessage(" [codex] 整理して")).toEqual({ provider: "codex", prompt: "整理して" });
  });
  it("does not turn an uncertain execution into another process", () => {
    expect(canChooseChore("interrupted", "continue")).toBe(false);
    expect(canChooseChore("running", "continue")).toBe(false);
    expect(canChooseChore("continued", "continue")).toBe(false);
    expect(canChooseChore("succeeded", "continue")).toBe(true);
    expect(canChooseChore("interrupted", "ok")).toBe(true);
  });
  it("rejects empty, oversized and unknown provider inputs", () => {
    expect(() => validateChoreInput(" ", "claude")).toThrow();
    expect(() => validateChoreInput("a".repeat(16001), "claude")).toThrow();
    expect(() => validateChoreInput("依頼", "unknown")).toThrow();
  });
});
