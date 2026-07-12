import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { loadProjectCodes } from "../../projects/project-codes.js";
import type { DiscordCommandSpec } from "../commands.js";

const projectsCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("projects")
    .setDescription("LUDIARS プロジェクトコード一覧を表示"),
  async execute(interaction, deps) {
    let categories;
    try {
      categories = loadProjectCodes(deps.resolveWorkspaceRoots?.() ?? []).categories;
    } catch (error) {
      await interaction.reply({
        content: `project codes unavailable: ${(error as Error).message}`,
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("LUDIARS プロジェクトコード一覧")
      .setColor(0x5865f2)
      .setFooter({ text: "正本: LUDIARS/PROJECT-CODES.md" });

    for (const category of categories) {
      const value = category.entries.map(([code, repo]) => `\`${code}\` ${repo}`).join("\n");
      embed.addFields({ name: category.name, value, inline: false });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

export default projectsCommand;
