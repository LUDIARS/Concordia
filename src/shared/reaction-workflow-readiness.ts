import { isReactionAllowAll, normalizeReactionUserIds, type ReactionUserAllowlistInput } from "./reaction-workflow-auth.js";

export type ReactionWorkflowReadinessStatus = "disabled" | "ready" | "no_authorized_users";
export type ReactionWorkflowReadinessIssue =
  | "discord_no_authorized_users"
  | "slack_no_authorized_users";

export interface ReactionWorkflowReadiness {
  status: ReactionWorkflowReadinessStatus;
  authorized_user_count: number;
  platforms: {
    discord: { authorized_user_count: number; allow_all: boolean };
    slack: { authorized_user_count: number; allow_all: boolean };
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
  const discordAllowAll = isReactionAllowAll(input.discordUserIds);
  const slackAllowAll = isReactionAllowAll(input.slackUserIds);
  const discordReady = discordAllowAll || discordCount > 0;
  const slackReady = slackAllowAll || slackCount > 0;
  const authorizedUserCount = discordCount + slackCount;
  const issues: ReactionWorkflowReadinessIssue[] = [];

  if (input.enabled && !discordReady) issues.push("discord_no_authorized_users");
  if (input.enabled && !slackReady) issues.push("slack_no_authorized_users");

  return {
    status: input.enabled
      ? ((discordReady || slackReady) ? "ready" : "no_authorized_users")
      : "disabled",
    authorized_user_count: authorizedUserCount,
    platforms: {
      discord: { authorized_user_count: discordCount, allow_all: discordAllowAll },
      slack: { authorized_user_count: slackCount, allow_all: slackAllowAll },
    },
    issues,
  };
}
