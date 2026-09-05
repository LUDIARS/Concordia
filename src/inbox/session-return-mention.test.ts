import { describe, expect, it } from "vitest";
import { resolveNoticeMention } from "./session-return-mention.js";

const fakeSnowflake = (suffix: number): string => `${"0".repeat(17)}${suffix}`;
const OWNER = fakeSnowflake(1);
const ADMIN = fakeSnowflake(2);
const SLACK_OWNER = "U00000001";

describe("resolveNoticeMention", () => {
  it("mentions the session owner alone", () => {
    expect(
      resolveNoticeMention({ owner: { platform: "discord", userId: OWNER }, adminDiscordUserId: ADMIN }),
    ).toEqual({ discord: [OWNER], slack: [] });
  });

  it("falls back to the admin when the owner cannot be resolved", () => {
    expect(resolveNoticeMention({ owner: null, adminDiscordUserId: ADMIN }))
      .toEqual({ discord: [ADMIN], slack: [] });
  });

  it("keeps a slack owner on the slack side", () => {
    expect(
      resolveNoticeMention({ owner: { platform: "slack", userId: SLACK_OWNER }, adminDiscordUserId: ADMIN }),
    ).toEqual({ discord: [], slack: [SLACK_OWNER] });
  });

  it("mentions nobody when neither is available", () => {
    expect(resolveNoticeMention({ owner: null, adminDiscordUserId: null }))
      .toEqual({ discord: [], slack: [] });
  });

  it("never returns more than one recipient", () => {
    // 置き換え前の managerMentionIds のように管理職全員を入れない。
    for (const owner of [{ platform: "discord" as const, userId: OWNER }, null]) {
      const m = resolveNoticeMention({ owner, adminDiscordUserId: ADMIN });
      expect(m.discord.length + m.slack.length).toBeLessThanOrEqual(1);
    }
  });

  it("treats a blank owner id as unresolved", () => {
    expect(resolveNoticeMention({ owner: { platform: "discord", userId: "  " }, adminDiscordUserId: ADMIN }))
      .toEqual({ discord: [ADMIN], slack: [] });
  });

  it("rejects malformed platform ids instead of breaking the notification send", () => {
    expect(resolveNoticeMention({
      owner: { platform: "discord", userId: "123> @everyone" },
      adminDiscordUserId: "also-invalid",
    })).toEqual({ discord: [], slack: [] });
  });
});
