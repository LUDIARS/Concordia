import { describe, expect, it } from "vitest";
import { shouldRelaySessionPromptToDiscord } from "./bot.js";

describe("shouldRelaySessionPromptToDiscord", () => {
  it("keeps Discord prompt relay scoped to codex-cli sessions", () => {
    expect(shouldRelaySessionPromptToDiscord("codex-cli")).toBe(true);
    expect(shouldRelaySessionPromptToDiscord("claude-code")).toBe(false);
    expect(shouldRelaySessionPromptToDiscord("gemini-cli")).toBe(false);
    expect(shouldRelaySessionPromptToDiscord(null)).toBe(false);
  });
});
