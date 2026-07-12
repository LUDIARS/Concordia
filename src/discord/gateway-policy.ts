export type DiscordGatewayEventKind = "reconnecting" | "disconnect" | "error";

/** discord.js can resume a reconnecting shard; disconnect/error require a bounded bot restart. */
export function shouldRestartDiscordBot(kind: DiscordGatewayEventKind): boolean {
  return kind !== "reconnecting";
}
