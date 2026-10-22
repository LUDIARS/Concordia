/**
 * Slack メンバー対応表 — Discord のユーザ ID を Slack のユーザ ID へ引く。
 *
 * session channel へ起動者を招待するとき、 Discord から起動された session は
 * Slack 側の誰なのかを Concordia だけでは判定できない (表示名は PF ごとに違う)。
 * 人間が設定画面で登録した対応表を正本にする (spec/feature/slack-platform.md)。
 *
 * SRP: 対応表の正規化と招待先の解決のみ。 永続化は config.ts、 招待は
 * session-starter-invite.ts。
 */

import type { Requester } from "../control/requester.js";

export interface SlackMemberMapEntry {
  discord_user_id: string;
  slack_user_id: string;
}

const DISCORD_ID = /^\d{5,32}$/;
const SLACK_ID = /^[UW][A-Z0-9]{2,31}$/;

/**
 * 入力を検証して正規化する。 空白除去、 Discord ID 重複は後勝ち。
 * 形式違反は Error (呼び出し側が 400 にする)。
 */
export function normalizeSlackMemberMap(entries: readonly SlackMemberMapEntry[]): SlackMemberMapEntry[] {
  const byDiscord = new Map<string, string>();
  for (const entry of entries) {
    const discord = entry.discord_user_id.trim();
    const slack = entry.slack_user_id.trim();
    if (!DISCORD_ID.test(discord)) throw new Error(`invalid Discord user id: ${discord}`);
    if (!SLACK_ID.test(slack)) throw new Error(`invalid Slack user id: ${slack}`);
    byDiscord.set(discord, slack);
  }
  return [...byDiscord].map(([discord_user_id, slack_user_id]) => ({ discord_user_id, slack_user_id }));
}

/** 保存済み JSON を読む。 壊れた値は空扱い (招待しないだけで、 session は止めない)。 */
export function parseSlackMemberMap(raw: string | null): SlackMemberMapEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeSlackMemberMap(parsed.filter(isEntryShape));
  } catch {
    return [];
  }
}

function isEntryShape(value: unknown): value is SlackMemberMapEntry {
  const row = value as Partial<SlackMemberMapEntry> | null;
  return typeof row?.discord_user_id === "string" && typeof row?.slack_user_id === "string";
}

/**
 * 起動者を Slack ユーザ ID に解決する。 Slack 起動はそのまま、 Discord 起動は
 * 対応表で引く。 対応なしは null。
 */
export function resolveSlackInvitee(
  requester: Requester | null,
  memberMap: readonly SlackMemberMapEntry[],
): string | null {
  if (!requester) return null;
  if (requester.platform === "slack") return requester.userId;
  return memberMap.find((entry) => entry.discord_user_id === requester.userId)?.slack_user_id ?? null;
}
