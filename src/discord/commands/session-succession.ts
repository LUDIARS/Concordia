import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

interface SessionSuccessionCommandOptions {
  name: "co-relictor" | "co-handover";
  description: string;
  endpoint: "relictor" | "handover";
  startingMessage: string;
  completedMessage: string;
}

/**
 * relictor / handover の Discord 境界を共有し、経路・応答処理のドリフトを防ぐ。
 * @implements spec/tasks/2026-08-14-handover-command.md
 */
export function createSessionSuccessionCommand(
  options: SessionSuccessionCommandOptions,
): DiscordCommandSpec {
  return {
    builder: new SlashCommandBuilder()
      .setName(options.name)
      .setDescription(options.description),
    async execute(interaction, deps) {
      const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
      if (!session) return;
      await interaction.reply({ content: options.startingMessage, ephemeral: true });
      const sessionId = encodeURIComponent(session.sessionId);
      const response = await callConcordia<{ ok: boolean; error?: string }>(
        deps.concordiaUrl,
        "POST",
        `/v1/sessions/${sessionId}/${options.endpoint}`,
      );
      if ("error" in response) {
        await interaction.followUp({ content: `⚠️ 失敗: ${response.error}`, ephemeral: true });
        return;
      }
      await interaction.followUp({ content: options.completedMessage, ephemeral: true });
    },
  };
}
