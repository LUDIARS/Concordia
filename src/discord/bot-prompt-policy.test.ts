import { describe, expect, it } from "vitest";
import { shouldPostPermissionRequestToDiscord, shouldRelaySessionPromptToDiscord } from "./bot.js";

describe("shouldRelaySessionPromptToDiscord", () => {
  it("keeps Discord prompt relay scoped to codex-cli sessions", () => {
    expect(shouldRelaySessionPromptToDiscord("codex-cli")).toBe(true);
    expect(shouldRelaySessionPromptToDiscord("claude-code")).toBe(false);
    expect(shouldRelaySessionPromptToDiscord("gemini-cli")).toBe(false);
    expect(shouldRelaySessionPromptToDiscord(null)).toBe(false);
  });
});

describe("shouldPostPermissionRequestToDiscord", () => {
  it("posts permission cards only when explicitly enabled", () => {
    expect(shouldPostPermissionRequestToDiscord({ permissionRequestsEnabled: true })).toBe(true);
    expect(shouldPostPermissionRequestToDiscord({ permissionRequestsEnabled: false })).toBe(false);
  });
});
