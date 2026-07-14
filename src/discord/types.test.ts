import { describe, expect, it } from "vitest";
import { readDiscordEnv } from "./types.js";

describe("readDiscordEnv forum migration", () => {
  it("enables forum mode by default in Phase 3", () => {
    expect(readDiscordEnv({}).forumMode).toBe(true);
  });

  it("keeps an explicit rollback switch", () => {
    expect(readDiscordEnv({ CONCORDIA_DISCORD_FORUM_MODE: "0" }).forumMode).toBe(false);
  });
});
