import { describe, expect, it } from "vitest";
import { isTranscriptCompletion } from "./transcript-completion.js";

describe("isTranscriptCompletion", () => {
  it("accepts summary and final assistant frames", () => {
    expect(isTranscriptCompletion("summary", { summary: "recap" })).toBe(true);
    expect(isTranscriptCompletion("text", {
      role: "assistant",
      phase: "final_answer",
      text: "done",
    })).toBe(true);
    expect(isTranscriptCompletion("text", { role: "assistant", text: "done" })).toBe(true);
  });

  it("rejects commentary, user text, and tool frames", () => {
    expect(isTranscriptCompletion("text", {
      role: "assistant",
      phase: "commentary",
      text: "working",
    })).toBe(false);
    expect(isTranscriptCompletion("text", { role: "user", text: "go" })).toBe(false);
    expect(isTranscriptCompletion("tool-use", {})).toBe(false);
  });
});
