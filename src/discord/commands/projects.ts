import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { ProjectCodeRow } from "../../db/project-codes-repo.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia } from "./_util.js";

interface ProjectCodesResponse {
  project_codes: ProjectCodeRow[];
}

const projectsCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("projects")
    .setDescription("Concordia の project code 登録一覧を表示"),
  async execute(interaction, deps) {
    const result = await callConcordia<ProjectCodesResponse>(deps.concordiaUrl, "GET", "/v1/project-codes");
    if ("error" in result) {
      await interaction.reply({ content: `project codes unavailable: ${result.error}`, ephemeral: true });
      return;
    }
    if (result.project_codes.length === 0) {
      await interaction.reply({ content: "project code はまだ登録されていません。", ephemeral: true });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Concordia project code registry")
      .setColor(0x5865f2)
      .setDescription(result.project_codes.map((row) => `\`${row.code}\` ${row.project}\n${row.repo_path}`).join("\n\n"))
      .setFooter({ text: "正本: Concordia DB" });
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

export default projectsCommand;
