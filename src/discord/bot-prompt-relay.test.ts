import { describe, expect, it } from "vitest";
import { shouldRelaySessionPromptProvider } from "./bot.js";

describe("shouldRelaySessionPromptProvider", () => {
  it("relays prompt events for CLI sessions whose user prompts are dropped from transcript frames", () => {
    expect(shouldRelaySessionPromptProvider("codex-cli")).toBe(true);
    expect(shouldRelaySessionPromptProvider("claude-code")).toBe(true);
  });

  it("does not relay prompt events for unsupported providers", () => {
    expect(shouldRelaySessionPromptProvider("gemini-cli")).toBe(false);
    expect(shouldRelaySessionPromptProvider("local-llm")).toBe(false);
    expect(shouldRelaySessionPromptProvider(null)).toBe(false);
  });
});
