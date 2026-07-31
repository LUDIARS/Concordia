/**
 * リアクションワークフローの発火可能性スナップショット。
 *
 * 「誰が発火できるか」 は社員名簿 (staff_members) の役職で決まるため、 ここは
 * platform ごとの「発火権限を持つ社員 (管理職以上) の人数」 だけを受け取る。
 * 旧 allowlist / 全員許可トークンは廃止済み (spec/feature/staff-roster.md §4)。
 */

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
  /** 発火権限 (reaction_workflow) を持つ Discord 社員の人数。 */
  discordAuthorizedCount: number;
  /** 発火権限を持つ Slack 社員の人数。 */
  slackAuthorizedCount: number;
}): ReactionWorkflowReadiness {
  const discordCount = Math.max(0, Math.trunc(input.discordAuthorizedCount));
  const slackCount = Math.max(0, Math.trunc(input.slackAuthorizedCount));
  const issues: ReactionWorkflowReadinessIssue[] = [];

  if (input.enabled && discordCount === 0) issues.push("discord_no_authorized_users");
  if (input.enabled && slackCount === 0) issues.push("slack_no_authorized_users");

  return {
    status: input.enabled
      ? ((discordCount > 0 || slackCount > 0) ? "ready" : "no_authorized_users")
      : "disabled",
    authorized_user_count: discordCount + slackCount,
    platforms: {
      discord: { authorized_user_count: discordCount },
      slack: { authorized_user_count: slackCount },
    },
    issues,
  };
}
