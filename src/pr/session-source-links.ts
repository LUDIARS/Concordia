import { WebClient } from "@slack/web-api";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";

export interface PrSourceLink {
  platform: "discord" | "slack";
  label: string;
  url: string;
}

interface SlackSessionSourceChannel {
  channel_id: string;
  header_ts: string | null;
}

export interface SessionSourceLinkDeps {
  discordChannels: Pick<DiscordSessionChannelsRepo, "findBySessionId">;
  slackChannels: {
    findBySessionId(sessionId: string): SlackSessionSourceChannel | null;
  };
  resolveDiscordGuildId(): string | null;
  resolveSlackBotToken(): string | null;
  resolveSlackPermalink?: (token: string, channelId: string, messageTs: string) => Promise<string | null>;
  log: { warn: (o: unknown, m: string) => void };
}

async function slackPermalink(token: string, channelId: string, messageTs: string): Promise<string | null> {
  const response = await new WebClient(token).chat.getPermalink({
    channel: channelId,
    message_ts: messageTs,
  });
  return safeSlackPermalink(response.permalink);
}

/** Revisor renders this as a navigation link, so never persist a non-Slack redirect. */
function safeSlackPermalink(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.hostname !== "slack.com" && !url.hostname.endsWith(".slack.com"))) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** PR を提出したセッションの Discord / Slack 投稿へ戻れるリンクを収集する。 */
export async function resolveSessionSourceLinks(
  deps: SessionSourceLinkDeps,
  sessionId: string,
): Promise<PrSourceLink[]> {
  const links: PrSourceLink[] = [];
  const discord = deps.discordChannels.findBySessionId(sessionId);
  const guildId = deps.resolveDiscordGuildId();
  if (discord?.surface_message_id && guildId) {
    links.push({
      platform: "discord",
      label: "Discord セッション投稿",
      url: `https://discord.com/channels/${guildId}/${discord.channel_id}/${discord.surface_message_id}`,
    });
  }

  const slack = deps.slackChannels.findBySessionId(sessionId);
  const token = deps.resolveSlackBotToken();
  if (slack?.header_ts && token) {
    try {
      const permalink = await (deps.resolveSlackPermalink ?? slackPermalink)(
        token,
        slack.channel_id,
        slack.header_ts,
      );
      const safePermalink = safeSlackPermalink(permalink);
      if (safePermalink) {
        links.push({ platform: "slack", label: "Slack セッション投稿", url: safePermalink });
      }
    } catch (error) {
      deps.log.warn(
        { session_id: sessionId, err: error instanceof Error ? error.message : String(error) },
        "Slack session permalink resolution failed",
      );
    }
  }
  return links;
}
