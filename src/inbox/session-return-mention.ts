/**
 * 未回答質問の通知を「誰に」向けるかを決める (純関数)。
 *
 * **担当者 1 人だけ**にする。直近の人間指示者を優先し、
 * 解決できなければ設定済みの管理者を使う。
 *
 * 置き換え前は `managerMentionIds` が社員名簿の staff 以外 (manager / executive) を
 * 全員メンションしていたため、大量通知時に全員が繰り返し ping されうる状態だった。
 *
 * question 行は担当者を持っていないので、そのセッションの直近の人間指示者を
 * 担当者とみなす。再訪トリガーになった inject の入力者を ingress
 * 境界から受け取り、「誰の指示で動いているセッションか」を曖昧にしない。
 *
 * SRP: 宛先の決定のみ。入力者の確定と投函は呼び出し側。
 *
 * @implements spec/feature/approval-inbox.md §3.2
 */

/** 通知の宛先。 platform ごとに 1 人だけ入る。 */
export interface NoticeMentions {
  readonly discord: string[];
  readonly slack: string[];
}

export interface ResolveNoticeMentionInput {
  /** そのセッションの直近の人間指示者 (= 担当者)。 解決できなければ null。 */
  readonly owner: { platform: "discord" | "slack"; userId: string } | null;
  /** 担当者が解決できないときの宛先 (`admin.mention_user_id`)。 */
  readonly adminDiscordUserId: string | null;
}

const DISCORD_USER_ID = /^\d{17,20}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{8,}$/;

/**
 * 担当者 → 管理者の順で 1 人だけ選ぶ。 どちらも無ければ空 (メンション無しで投稿する)。
 *
 * @implements spec/feature/approval-inbox.md §3.2
 */
export function resolveNoticeMention(input: ResolveNoticeMentionInput): NoticeMentions {
  const owner = input.owner;
  const ownerId = owner?.userId.trim() ?? "";
  if (owner?.platform === "slack" && SLACK_USER_ID.test(ownerId)) {
    return { discord: [], slack: [ownerId] };
  }
  if (owner?.platform === "discord" && DISCORD_USER_ID.test(ownerId)) {
    return { discord: [ownerId], slack: [] };
  }
  const admin = input.adminDiscordUserId?.trim();
  return admin && DISCORD_USER_ID.test(admin)
    ? { discord: [admin], slack: [] }
    : { discord: [], slack: [] };
}
