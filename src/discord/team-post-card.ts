// チーム面へ本文付きカードを 1 枚投稿する (朝礼 / 定例通知)。
//
// 既存の監査カード (team-audit-card.ts) が「Cc 内部イベントの記録」なのに対し、
// こちらは delegation (朝礼 / 定例) が API 経由で投げてくる報告を面へ載せる。
// 投稿先の決定は team-card-routing.ts に委ね、 ここは描画と送信だけを持つ。

import { EmbedBuilder, type Guild } from "discord.js";
import type { TeamsRepo } from "../db/teams-repo.js";
import { resolveTeamCardChannel, type TeamCardKind } from "./team-card-routing.js";

/** Discord embed description の上限 (4096) に対する安全側の切り詰め幅。 */
const MAX_BODY = 3800;

const CARD_COLOR: Partial<Record<TeamCardKind, number>> = {
  standup: 0x5865f2,
  meeting: 0xeb459e,
  // Director 巡回の人間エスカレーション (spec/feature/director-patrol.md §1.4)。
  question: 0xf0b232,
  // タスク整理の報告 (spec/feature/director-workflow.md §2)。
  "task-kanban": 0x57f287,
  // Director 課題スカウトの進言 (spec/feature/director-issue-scout.md §3)。
  "issue-hypothesis": 0x9b59b6,
};

const CARD_LABEL: Partial<Record<TeamCardKind, string>> = {
  "issue-hypothesis": "課題スカウト",
};

export interface TeamPostCardDeps {
  guild: Guild;
  teamsRepo: TeamsRepo;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** @deprecated 呼び出し元で会社所有権を検証する。後方互換のため受け付ける。 */
  subsidiary?: boolean;
}

export interface TeamPostCardInput {
  teamId: string;
  kind: TeamCardKind;
  title: string;
  body: string;
}

/** 4096 文字上限に収める。 切り詰めた事実は本文に残す (黙って消さない)。 */
export function truncateCardBody(body: string, max: number = MAX_BODY): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n…(以下省略: ${body.length - max} 文字)`;
}

/**
 * チーム面へカードを投稿する。
 *
 * 面が未プロビジョニングなら投稿せず false を返す (エラーにしない)。 朝礼が
 * 面の準備前に走っても cron 全体を落とさないため。
 */
export async function postTeamCard(deps: TeamPostCardDeps, input: TeamPostCardInput): Promise<boolean> {
  const channelId = resolveTeamCardChannel(deps.teamsRepo, input.teamId, input.kind);
  if (!channelId) {
    deps.log.info(`team-post-card: surface missing for team=${input.teamId} kind=${input.kind}, skip`);
    return false;
  }

  const channel = await deps.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    deps.log.warn(`team-post-card: channel ${channelId} not sendable for team=${input.teamId}`);
    return false;
  }

  const embed = new EmbedBuilder()
    .setTitle(input.title)
    .setDescription(truncateCardBody(input.body))
    .setColor(CARD_COLOR[input.kind] ?? 0x99aab5);
  const label = CARD_LABEL[input.kind];
  if (label) embed.setAuthor({ name: label });

  // 報告カードでメンションを飛ばさない (本文に @ が混ざっても通知を撒かない)。
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  deps.log.info(`team-post-card: posted team=${input.teamId} kind=${input.kind} channel=${channelId}`);
  return true;
}
