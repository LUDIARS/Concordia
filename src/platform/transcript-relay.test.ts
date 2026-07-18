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

  it("relays Codex commentary when message optimization is off (default)", () => {
    expect(extractRelayableTextFrame("text", {
      role: "assistant",
      phase: "commentary",
      text: "working",
    })).toEqual({ role: "assistant", text: "working" });
  });

  it("drops Codex commentary when message optimization is on, keeping final_answer", () => {
    expect(extractRelayableTextFrame("text", {
      role: "assistant",
      phase: "commentary",
      text: "working",
    }, { messageOptimizationEnabled: true, provider: "codex-cli" })).toBeNull();
    expect(extractRelayableTextFrame("text", {
      role: "assistant",
      phase: "final_answer",
      text: "done",
    }, { messageOptimizationEnabled: true, provider: "codex-cli" })).toEqual({ role: "assistant", text: "done" });
  });

  it("preserves the optimized-message policy for non-Codex providers", () => {
    expect(extractRelayableTextFrame("text", { role: "assistant", text: "done" }, {
      messageOptimizationEnabled: true,
      provider: "claude",
    })).toBeNull();
  });
});
