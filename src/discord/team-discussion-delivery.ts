// @spec チーム相談のファシリテーション
import { createHash } from "node:crypto";
import { ChannelType, type Guild, type MessageCreateOptions } from "discord.js";
import { DiscussionDeliveryRejected, type DiscussionDeliver } from "../team-discussion-conversation/conversation.js";
import { chunkForDiscord } from "./formatter.js";
import { definiteDiscordRejection } from "./sprint-dialogues-surface.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:b634f759 */
import augurContract_8daa9c80 from './team-discussion-delivery.contract.js'; /* augur-inject:contract-predicate:262b9876 */

export function discussionPostOptions(channelId: string, through: string, part: number, content: string): MessageCreateOptions {
  return {
    content,
    allowedMentions: { parse: [] },
    nonce: createHash("sha256").update(`team-discussion:${channelId}:${through}:${part}`).digest("hex").slice(0, 24),
    enforceNonce: true,
  };
}
// @ts-expect-error augur-inject
discussionPostOptions = contract(discussionPostOptions, { ...augurContract_8daa9c80, contractId: 'team-discussion-facilitator-C-205', mode: 'observe', sample: 1, where: 'src/discord/team-discussion-delivery.ts:8', rule: 'contract-wrap', id: '8daa9c80' }); /* augur-inject:contract-wrap:8daa9c80 */

export function discordDiscussionDelivery(input: {
  guild: Guild;
  ownerOf: (channel: string, category: string | null) => string | null;
  ownsTeam: (teamId: string) => boolean;
}): DiscussionDeliver {
  return async (job, signal) => {
    if (signal.aborted) return null;
    const chunks = chunkForDiscord(job.delta, 2000);
    const content = chunks[job.part];
    if (!content) throw new DiscussionDeliveryRejected("The saved summary part is missing");

    let channel;
    try {
      channel = await input.guild.channels.fetch(job.channelId);
    } catch (error) {
      throw new DiscussionDeliveryRejected("The discussion channel could not be verified", { cause: error });
    }
    if (signal.aborted) return null;
    if (!channel?.isSendable() || channel.type === ChannelType.PrivateThread) {
      throw new DiscussionDeliveryRejected("Discussion channel is unavailable");
    }
    const surface = channel.isThread() ? channel.parent : channel;
    if (surface?.id !== job.surfaceId || input.ownerOf(surface.id, surface.parentId) !== job.teamId || !input.ownsTeam(job.teamId)) {
      throw new DiscussionDeliveryRejected("Discussion scope no longer matches");
    }

    try {
      const sent = await channel.send(discussionPostOptions(job.channelId, job.through, job.part, content));
      return { id: sent.id, last: job.part === chunks.length - 1 };
    } catch (error) {
      if (definiteDiscordRejection(error)) throw new DiscussionDeliveryRejected("Discord rejected the discussion summary", { cause: error });
      throw error;
    }
  };
}
