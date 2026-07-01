import type { ChatInputCommandInteraction } from "discord.js";
import type { DiscordSessionChannelsRepo } from "../../db/discord-repo.js";

export async function requireSessionChannel(
  interaction: ChatInputCommandInteraction,
  sessionChannelsRepo: DiscordSessionChannelsRepo,
): Promise<{ sessionId: string; channelId: string } | null> {
  const row = sessionChannelsRepo.findByChannelId(interaction.channelId);
  if (!row) {
    const content = "This command is only available in a session channel.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
    return null;
  }
  return { sessionId: row.session_id, channelId: row.channel_id };
}

export async function callConcordia<T>(
  baseUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<T | { error: string }> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as T | { error: string }) : ({} as T);
    if (!res.ok) {
      const msg = typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : `HTTP ${res.status}`;
      return { error: msg };
    }
    return json;
  } catch (err) {
    return { error: (err as Error).message };
  }
}
