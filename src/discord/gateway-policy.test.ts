import { describe, expect, it } from "vitest";
import { shouldRestartDiscordBot } from "./gateway-policy.js";

describe("Discord gateway policy", () => {
  it("leaves transient reconnects to discord.js resume", () => {
    expect(shouldRestartDiscordBot("reconnecting")).toBe(false);
  });

  it("requests a bounded restart for terminal disconnects and errors", () => {
    expect(shouldRestartDiscordBot("disconnect")).toBe(true);
    expect(shouldRestartDiscordBot("error")).toBe(true);
  });
});
