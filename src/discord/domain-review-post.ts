/**
 * src/discord/domain-review-post.ts — ドメインレビューを Discord へ 1 通投稿する。
 *
 * 投稿先の決め方 (対象プロジェクトの面):
 *   1. 明示指定 (`/domain-review` を打ったチャンネル)
 *   2. 契機となったセッションのスレッド (plan / local PR は必ずセッション起点)
 *   3. houkoku (報告) チャンネル
 *
 * Cc の Discord レイアウトにはプロジェクト専用チャンネルが無く、 プロジェクトの面は
 * 「そのプロジェクトを触っているセッションのスレッド」である。 だから 2 を主経路にし、
 * セッションを伴わない投稿だけ 3 に落とす。
 *
 * メンションは二重に止める: 本文側は embed-limits の無害化、 送信側は
 * `allowedMentions: { parse: [] }`。 ドメイン名も説明も Anatomia / LLM 由来で、
 * 片方だけでは「読める形で残す」と「発火させない」を両立できない。
 *
 * SRP: 宛先解決と送信。 描画は domain-review-embeds.ts。
 *
 * @implements spec/feature/domain-review-discord.md §2.2, §2.5
 */

import { EmbedBuilder, type Guild } from "discord.js";
import type { DomainReviewPostPort } from "../domain-review/service.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { buildAttachFiles } from "./attachment-files.js";
import { buildDomainReviewEmbeds } from "./domain-review-embeds.js";

export interface DomainReviewPosterDeps {
  guild: Guild;
  sessionChannels: DiscordSessionChannelsRepo;
  /** houkoku チャンネル ID (無ければ null)。 */
  resolveHoukokuChannelId: () => string | null;
  resolveWorkspaceRoots: () => string[];
  log: { info: (m: string) => void; warn: (m: string) => void };
}

/** Cc core から使う投稿ポートの Discord 実装。 */
export function createDiscordDomainReviewPoster(deps: DomainReviewPosterDeps): DomainReviewPostPort {
  return {
    async post(input) {
      const channelId = resolveChannelId(deps, input.channelId, input.sessionId);
      if (!channelId) {
        deps.log.info(
          `domain-review: 投稿先が決まらないため見送る code=${input.report.target.code} `
          + `session=${input.sessionId ?? "-"}`,
        );
        return null;
      }
      const channel = await deps.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || !("send" in channel)) {
        deps.log.warn(`domain-review: channel ${channelId} へ送れない (code=${input.report.target.code})`);
        return null;
      }

      const embeds = buildDomainReviewEmbeds(input.report).map((embed) => new EmbedBuilder(embed));
      const files = await buildAttachFiles(
        input.attachmentPaths,
        `domain-review code=${input.report.target.code}`,
        deps.log,
        deps.resolveWorkspaceRoots(),
      );
      try {
        const sent = await channel.send({
          embeds,
          allowedMentions: { parse: [] },
          ...(files.length > 0 ? { files } : {}),
        });
        return { platform: "discord", channelId, messageId: sent.id };
      } catch (error) {
        deps.log.warn(
          `domain-review: 投稿に失敗 code=${input.report.target.code} channel=${channelId}: `
          + `${(error as Error).message}`,
        );
        return null;
      }
    },
  };
}

/** 明示指定 → セッション面 → houkoku の順。 どれも無ければ null。 */
export function resolveChannelId(
  deps: Pick<DomainReviewPosterDeps, "sessionChannels" | "resolveHoukokuChannelId">,
  explicitChannelId: string | null,
  sessionId: string | null,
): string | null {
  if (explicitChannelId) return explicitChannelId;
  if (sessionId) {
    const row = deps.sessionChannels.findBySessionId(sessionId);
    // 終了したセッションのスレッドへ後から投げても読まれない (アーカイブされる)。
    if (row && row.status === "active") return row.channel_id;
  }
  return deps.resolveHoukokuChannelId();
}
