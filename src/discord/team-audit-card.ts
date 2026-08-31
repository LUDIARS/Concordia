// team.created / team.changed の変更内容を、 team の direction 面 (team_surfaces
// の surface='direction' に保存済み channel_id) へ監査カードとして投稿する。
//
// - 呼び出し元 runtime が会社所有権を検証し、対象 guild へだけ投稿する。
// - 同一イベントの再配信/bot 再起動で二重投稿しないよう、 team_audit_posts への
//   claim (INSERT ... ON CONFLICT DO NOTHING) を「投稿 1 回」の唯一の関門にする。
// - direction 面が未プロビジョニングなら安全にスキップする (エラーにしない)。

import { EmbedBuilder, type Guild } from "discord.js";
import type { TeamsRepo } from "../db/teams-repo.js";

export interface TeamAuditCardDeps {
  guild: Guild;
  teamsRepo: TeamsRepo;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** @deprecated 呼び出し元で会社所有権を検証する。後方互換のため受け付ける。 */
  subsidiary?: boolean;
}

export type TeamAuditCardInput =
  | { kind: "created"; eventId: string; teamId: string; name: string; slug: string; ts: number }
  | { kind: "changed"; eventId: string; teamId: string; fields: string[]; ts: number };

function dedupeKeyFor(input: TeamAuditCardInput): string {
  return `${input.kind}:${input.eventId}`;
}

function renderCard(input: TeamAuditCardInput): { embeds: EmbedBuilder[] } {
  if (input.kind === "created") {
    return {
      embeds: [new EmbedBuilder()
        .setTitle("Team created")
        .setDescription(`\`${input.name}\` (${input.slug})`)
        .setColor(0x57f287)],
    };
  }
  return {
    embeds: [new EmbedBuilder()
      .setTitle("Team settings changed")
      .setDescription(`Fields: ${input.fields.join(", ")}`)
      .setColor(0xfee75c)],
  };
}

/**
 * team.created / team.changed の監査カードを direction 面へ 1 回だけ投稿する。
 *
 * direction 面が存在することを確認してから dedupe を claim する。面が未プロビジョニングで
 * claim してしまうと、後で面が用意されても再配信時に投稿できなくなるため。
 */
export async function postTeamAuditCard(deps: TeamAuditCardDeps, input: TeamAuditCardInput): Promise<void> {
  const dedupeKey = dedupeKeyFor(input);
  const channelId = deps.teamsRepo.surfaceChannelId(input.teamId, "direction");
  if (!channelId) {
    deps.log.info(`team-audit-card: direction surface missing for team=${input.teamId}, skip`);
    return;
  }

  if (!deps.teamsRepo.claimAuditPost(dedupeKey, input.teamId)) {
    deps.log.info(`team-audit-card: skip duplicate ${dedupeKey}`);
    return;
  }

  try {
    const channel = await deps.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !("send" in channel)) {
      deps.log.warn(`team-audit-card: direction channel ${channelId} not text-based for team=${input.teamId}`);
      return;
    }
    await channel.send({ ...renderCard(input), allowedMentions: { parse: [] } });
    deps.log.info(`team-audit-card: posted ${dedupeKey}`);
  } catch (e) {
    deps.log.warn(`team-audit-card: post failed team=${input.teamId}: ${(e as Error).message}`);
  }
}
