import type { Interaction } from "discord.js";

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

export function discordSnowflakeTimestampMs(id: string): number | null {
  try {
    const snowflake = BigInt(id);
    if (snowflake < 0n) return null;
    return Number((snowflake >> 22n) + DISCORD_EPOCH_MS);
  } catch {
    return null;
  }
}

export function interactionAgeMs(interaction: Pick<Interaction, "id">, now: number = Date.now()): number | null {
  const createdAt = discordSnowflakeTimestampMs(interaction.id);
  return createdAt === null ? null : now - createdAt;
}

export function describeInteractionForLog(interaction: Interaction): string {
  if (interaction.isChatInputCommand()) return `command=${interaction.commandName}`;
  if (interaction.isAutocomplete()) return `autocomplete=${interaction.commandName}`;
  if (interaction.isButton() || interaction.isStringSelectMenu()) return `custom_id=${interaction.customId}`;
  if (interaction.isModalSubmit()) return `modal=${interaction.customId}`;
  return `type=${interaction.type}`;
}
