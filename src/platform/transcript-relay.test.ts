import { describe, expect, it } from "vitest";
import { extractRelayableTextFrame } from "./transcript-relay.js";

describe("extractRelayableTextFrame", () => {
  it("relays final answers and summaries", () => {
    expect(extractRelayableTextFrame("text", {
      role: "assistant",
      phase: "final_answer",
      text: "done",
    })).toEqual({ role: "assistant", text: "done" });
    expect(extractRelayableTextFrame("summary", { summary: "recap" })).toEqual({
      role: "summary",
      text: "recap",
    });
  });

  it("drops Codex commentary for every chat adapter", () => {
    expect(extractRelayableTextFrame("text", {
      role: "assistant",
      phase: "commentary",
      text: "working",
    })).toBeNull();
  });

  it("preserves the optimized-message policy for non-Codex providers", () => {
    expect(extractRelayableTextFrame("text", { role: "assistant", text: "done" }, {
      messageOptimizationEnabled: true,
      provider: "claude",
    })).toBeNull();
  });
});
