import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { requireSessionChannel } from "./_util.js";
import { buildContextReport } from "../context-report.js";

export const CONTEXT_COMPACT_PREFIX = "context:compact:";

const contextCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder().setName("co-context").setDescription("現在のコンテキスト占有と残量を再推定"),
  async execute(interaction, deps) {
    const link = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!link) return;
    const session = deps.sessionsRepo.findSession(link.sessionId);
    if (!session) {
      await interaction.reply({ content: "対象セッションが見つかりません。", ephemeral: true });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONTEXT_COMPACT_PREFIX}${session.id}`)
        .setLabel("いまコンパクションする")
        .setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({ content: await buildContextReport(session), components: [row], ephemeral: true });
  },
};

export default contextCommand;
