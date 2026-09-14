import { describe, expect, it } from "vitest";
import { contextObservationFromLines } from "./context-observation.js";
import { formatContextBadge, toEstimate } from "./context-estimate.js";

const codex = (input: number, window = 258400) => JSON.stringify({ type: "event_msg", payload: {
  type: "token_count", info: { model_context_window: window,
    last_token_usage: { input_tokens: input, cached_input_tokens: input - 10 },
    total_token_usage: { input_tokens: 9000000 } },
} });

describe("provider context observations", () => {
  it("uses the recorded window without adding cached or cumulative usage", () => {
    const value = contextObservationFromLines([codex(187800)], "codex-cli");
    expect(value).toEqual({ tokens: 187800, windowTokens: 258400 });
    expect(toEstimate(value!.tokens, value!.windowTokens).pct).toBeCloseTo(0.7268, 4);
  });
  it("invalidates the old request at compaction until a new measurement arrives", () => {
    const compact = JSON.stringify({ type: "compacted" });
    expect(contextObservationFromLines([codex(187800), compact], "codex-cli")).toBeNull();
    expect(contextObservationFromLines([codex(187800), compact, codex(23000)], "codex-cli")?.tokens).toBe(23000);
  });
  it("retains Claude input above 200k without inventing a window or reading sidechains", () => {
    const assistant = { type: "assistant", message: { usage: {
      input_tokens: 492, cache_read_input_tokens: 300000, cache_creation_input_tokens: 30000,
    } } };
    const value = contextObservationFromLines([
      JSON.stringify(assistant), JSON.stringify({ ...assistant, isSidechain: true }),
    ], "claude-code");
    expect(value).toEqual({ tokens: 330492, windowTokens: null });
    expect(formatContextBadge(toEstimate(330492, null))).toContain("窓サイズ不明");
  });
  it("invalidates Claude snapshots at a compact boundary", () => {
    expect(contextObservationFromLines([
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 50000 } } }),
      JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    ], "claude-code")).toBeNull();
  });
  it("rejects malformed and negative measurements", () => {
    expect(contextObservationFromLines(["{", codex(-1)], "codex-cli")).toBeNull();
  });
});
