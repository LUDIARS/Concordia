import { describe, expect, it } from "vitest";
import { extractRelayableTextFrame } from "./transcript-relay.js";

// @implements spec/feature/discord-lictor-relay.md — ask マーカーの fail-loud 中継

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

  it("relays a raw ask marker as a fail-loud fallback", () => {
    const rawAsk =
      '```ask\n{"question":"どっち?","options":[{"label":"A"},{"label":"B"}]}\n```';
    const frame = extractRelayableTextFrame("text", {
      role: "assistant",
      phase: "final_answer",
      text: rawAsk,
    });

    expect(frame?.role).toBe("assistant");
    expect(frame?.text).toContain("質問カードを生成できませんでした");
    expect(frame?.text).toContain(rawAsk);
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
