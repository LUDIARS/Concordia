import { describe, expect, it } from "vitest";
import { getReactionWorkflowReadiness } from "./reaction-workflow-readiness.js";

describe("reaction workflow readiness", () => {
  it("reports enabled with no privileged staff as having no authorized users", () => {
    expect(getReactionWorkflowReadiness({
      enabled: true,
      discordAuthorizedCount: 0,
      slackAuthorizedCount: 0,
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

  it("reports per-platform counts and becomes ready when either side has staff", () => {
    const readiness = getReactionWorkflowReadiness({
      enabled: true,
      discordAuthorizedCount: 2,
      slackAuthorizedCount: 0,
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.authorized_user_count).toBe(2);
    expect(readiness.platforms.discord.authorized_user_count).toBe(2);
    expect(readiness.issues).toEqual(["slack_no_authorized_users"]);
  });

  it("does not report authorization issues while disabled", () => {
    expect(getReactionWorkflowReadiness({
      enabled: false,
      discordAuthorizedCount: 0,
      slackAuthorizedCount: 0,
    }).issues).toEqual([]);
  });

  it("clamps nonsense counts instead of trusting them", () => {
    const readiness = getReactionWorkflowReadiness({
      enabled: true,
      discordAuthorizedCount: -3,
      slackAuthorizedCount: 1.9,
    });

    expect(readiness.platforms.discord.authorized_user_count).toBe(0);
    expect(readiness.platforms.slack.authorized_user_count).toBe(1);
  });
});
