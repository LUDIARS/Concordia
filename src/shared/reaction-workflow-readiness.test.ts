import { describe, expect, it } from "vitest";
import { getReactionWorkflowReadiness } from "./reaction-workflow-readiness.js";

describe("reaction workflow readiness", () => {
  it("reports enabled with empty allowlists as having no authorized users", () => {
    expect(getReactionWorkflowReadiness({
      enabled: true,
      discordUserIds: [],
      slackUserIds: [],
    })).toEqual({
      status: "no_authorized_users",
      authorized_user_count: 0,
      platforms: {
        discord: { authorized_user_count: 0 },
        slack: { authorized_user_count: 0 },
      },
      issues: ["discord_no_authorized_users", "slack_no_authorized_users"],
    });
  });

  it("reports configured counts without exposing IDs", () => {
    const readiness = getReactionWorkflowReadiness({
      enabled: true,
      discordUserIds: ["discord-operator"],
      slackUserIds: ["slack-operator", "slack-operator"],
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.authorized_user_count).toBe(2);
    expect(readiness.platforms.discord.authorized_user_count).toBe(1);
    expect(readiness.platforms.slack.authorized_user_count).toBe(1);
    expect(JSON.stringify(readiness)).not.toContain("operator");
  });

  it("does not report authorization issues while disabled", () => {
    expect(getReactionWorkflowReadiness({
      enabled: false,
      discordUserIds: [],
      slackUserIds: [],
    }).issues).toEqual([]);
  });
});
