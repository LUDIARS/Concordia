/**
 * 巡回 rule の投稿先 channel。 rule.target が既知の channel ならそれ、 無ければ chitchat。
 * system / genius など会話の場でない channel へは巡回投稿させない。
 */

import type { RuleRow } from "../db/rules-repo.js";

export const PATROL_CHANNELS = ["chitchat", "報告", "ぼやき"] as const;
export type PatrolChannel = (typeof PATROL_CHANNELS)[number];

export function resolveChannelFor(rule: Pick<RuleRow, "target">): PatrolChannel {
  return (PATROL_CHANNELS as readonly string[]).includes(rule.target ?? "")
    ? (rule.target as PatrolChannel)
    : "chitchat";
}
