import { describe, expect, it } from "vitest";
import { recordDiscordBotStop, type DiscordRestartPolicyState } from "./discord-restart-policy.js";

describe("discord restart policy", () => {
  it("allows restarts below the short-window stop limit", () => {
    const state: DiscordRestartPolicyState = { stops: [] };
    for (let i = 0; i < 4; i++) {
      const decision = recordDiscordBotStop(state, { nowMs: 1_000 + i, windowMs: 60_000, limit: 5 });
      expect(decision.shouldRestart).toBe(true);
      expect(decision.recentStops).toBe(i + 1);
    }
  });

  it("suppresses restart on the fifth stop in the short window", () => {
    const state: DiscordRestartPolicyState = { stops: [] };
    for (let i = 0; i < 4; i++) {
      recordDiscordBotStop(state, { nowMs: 1_000 + i, windowMs: 60_000, limit: 5 });
    }
    const decision = recordDiscordBotStop(state, { nowMs: 1_004, windowMs: 60_000, limit: 5 });
    expect(decision.shouldRestart).toBe(false);
    expect(decision.limited).toBe(true);
    expect(decision.recentStops).toBe(5);
  });

  it("forgets stops outside the window", () => {
    const state: DiscordRestartPolicyState = { stops: [0, 1, 2, 3] };
    const decision = recordDiscordBotStop(state, { nowMs: 120_000, windowMs: 60_000, limit: 5 });
    expect(decision.shouldRestart).toBe(true);
    expect(decision.recentStops).toBe(1);
    expect(state.stops).toEqual([120_000]);
  });
});
