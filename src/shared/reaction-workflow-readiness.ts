/**
 * リアクションワークフローの実効性スナップショット。
 *
 * 発火自体は誰でもできる (リアクション = 指示の簡略化) ので、 数えるのは
 * platform ごとの「権限を要する指示 (merge) を実行できる社員 = 管理職以上の人数」。
 * 0 人なら ON にしても「押せるが merge が起きない」 ため警告する価値がある。
 * 呼び出し側は `merge_pr` の人数を渡す。 spawn (🤝 delegate-task) は 2026-10-03 から
 * ヒラ社員でもできる (承認なし) ので、 権限者の数え方には使わない。
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
  /** 権限を要する指示を実行できる Discord 社員 (管理職以上) の人数。 */
  discordAuthorizedCount: number;
  /** 権限を要する指示を実行できる Slack 社員 (管理職以上) の人数。 */
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
