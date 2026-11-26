// @spec チーム相談のファシリテーション
import type { Database } from "better-sqlite3";
import type { Guild } from "discord.js";
import { discussionFacilitator, type DiscussionRunner } from "../team-discussion-conversation/conversation.js";
import { DiscussionFacilitationRepository } from "../team-discussion-conversation/repository.js";
import { discordDiscussionDelivery } from "./team-discussion-delivery.js";
import { discussionOwner } from "./team-discussion.js";

export function startTeamDiscussionFacilitation(input: {
  db: Database;
  guild: Guild;
  subsidiaryId: string | null;
  ownsTeam: (teamId: string) => boolean;
  historyReady: (teamId: string) => boolean;
  run: DiscussionRunner;
  warn: (message: string) => void;
}) {
  const repo = new DiscussionFacilitationRepository(input.db, input.guild.id, input.subsidiaryId);
  const ownerOf = (channel: string, category: string | null) => discussionOwner(input.db, channel, category);
  const worker = discussionFacilitator({ ...input, repo, deliver: discordDiscussionDelivery({ ...input, ownerOf }) });
  const timer = setInterval(() => { void worker.tick(); }, 3000);
  timer.unref();
  return {
    stop(): Promise<void> {
      clearInterval(timer);
      return worker.stop();
    },
  };
}
