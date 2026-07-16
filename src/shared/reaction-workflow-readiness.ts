import { normalizeReactionUserIds, type ReactionUserAllowlistInput } from "./reaction-workflow-auth.js";

export type ReactionWorkflowReadinessStatus = "disabled" | "ready" | "no_authorized_users";
export type ReactionWorkflowReadinessIssue =
  | "discord_no_authorized_users"
  | "slack_no_authorized_users";

export interface ReactionWorkflowReadiness {
  status: ReactionWorkflowReadinessStatus;
  authorized_user_count: number;
  platforms: {
    discord: { authorized_user_count: number };
    slack: { authorized_user_count: number };
  };
  issues: ReactionWorkflowReadinessIssue[];
}

/** Build a non-sensitive readiness snapshot. User IDs are deliberately omitted. */
export function getReactionWorkflowReadiness(input: {
  enabled: boolean;
  discordUserIds: ReactionUserAllowlistInput;
  slackUserIds: ReactionUserAllowlistInput;
}): ReactionWorkflowReadiness {
  const discordCount = normalizeReactionUserIds(input.discordUserIds).length;
  const slackCount = normalizeReactionUserIds(input.slackUserIds).length;
  const authorizedUserCount = discordCount + slackCount;
  const issues: ReactionWorkflowReadinessIssue[] = [];

  if (input.enabled && discordCount === 0) issues.push("discord_no_authorized_users");
  if (input.enabled && slackCount === 0) issues.push("slack_no_authorized_users");

  return {
    status: input.enabled
      ? (authorizedUserCount > 0 ? "ready" : "no_authorized_users")
      : "disabled",
    authorized_user_count: authorizedUserCount,
    platforms: {
      discord: { authorized_user_count: discordCount },
      slack: { authorized_user_count: slackCount },
    },
    issues,
  };
}
