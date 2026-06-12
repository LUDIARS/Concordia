import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { archiveStaleChannels } from "../session-channel.js";

const cleanCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-clean")
    .setDescription("終了済みセッションチャンネルをログ保存して一括削除する"),

  async execute(interaction, deps) {
    await interaction.deferReply({ ephemeral: true });
    const { scanned, archived } = await archiveStaleChannels({
      guild: deps.guild,
      layout: deps.layout,
      repo: deps.sessionChannelsRepo,
      log: deps.log,
      force: true,
    });
    await interaction.editReply(
      `✅ スキャン: ${scanned} チャンネル → 保存&削除: ${archived} チャンネル`,
    );
  },
};

export default cleanCommand;
