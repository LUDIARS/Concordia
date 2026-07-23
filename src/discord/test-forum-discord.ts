import { ChannelType, type Guild } from "discord.js";
import type { DiscordTestSurfaceRow } from "../db/discord-test-surfaces-repo.js";
import type {
  TestForumCandidate,
  TestForumSurfaceAdapter,
  TestSurfaceCloseReason,
} from "./test-forum-reconcile.js";

function threadName(candidate: TestForumCandidate): string {
  const repo = candidate.repoOrigin.split("/").pop() ?? candidate.repoOrigin;
  return `[${repo} #${candidate.prNumber}] ${candidate.title}`.replace(/\s+/g, " ").slice(0, 100);
}

function starterContent(candidate: TestForumCandidate): string {
  return [
    `**Test candidate** ${candidate.url ? `[#${candidate.prNumber}](${candidate.url})` : `#${candidate.prNumber}`}`,
    `**Repo** \`${candidate.repoOrigin}\``,
    `**Head** \`${candidate.headBranch ?? "-"}\` @ \`${candidate.headSha}\``,
    `**Worktree** ${candidate.worktreePath ? `\`${candidate.worktreePath}\`` : "なし"}`,
    "この投稿は Cc 起動時の同期で作成されました。head 更新・PR close/merge・worktree 削除時に閉じます。",
  ].join("\n");
}

export function createTestForumDiscordAdapter(
  guild: Guild,
  forumId: string,
): TestForumSurfaceAdapter {
  return {
    async create(candidate) {
      const forum = guild.channels.cache.get(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) {
        throw new Error(`Test forum is unavailable: ${forumId || "(empty id)"}`);
      }
      const thread = await forum.threads.create({
        name: threadName(candidate),
        message: { content: starterContent(candidate) },
        reason: `Concordia test candidate ${candidate.repoOrigin}#${candidate.prNumber}@${candidate.headSha}`,
      });
      return { threadId: thread.id };
    },
    async close(surface: DiscordTestSurfaceRow, reason: TestSurfaceCloseReason) {
      const cached = guild.channels.cache.get(surface.thread_id);
      const channel = cached ?? await guild.channels.fetch(surface.thread_id).catch(() => null);
      if (!channel) return;
      if (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread) {
        throw new Error(`Test surface is not a thread: ${surface.thread_id}`);
      }
      if (!channel.archived) {
        await channel.setArchived(true, `Concordia test candidate closed: ${reason}`);
      }
    },
  };
}
