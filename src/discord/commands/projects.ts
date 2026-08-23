import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { clipProjectCodeList } from "../project-code-view.js";
import { callConcordia } from "./_util.js";

interface ProjectCodeView {
  code: string;
  project: string;
}

interface ProjectCodesResponse {
  project_codes: ProjectCodeView[];
}

const MAX_EMBED_DESCRIPTION = 4_000;

const projectsCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("projects")
    .setDescription("Concordia の project code 登録一覧を表示"),
  async execute(interaction, deps) {
    const result = await callConcordia<ProjectCodesResponse>(deps.concordiaUrl, "GET", "/v1/project-codes");
    if ("error" in result) {
      await interaction.reply({
        content: `project codes unavailable: ${result.error}`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (result.project_codes.length === 0) {
      await interaction.reply({ content: "project code はまだ登録されていません。", ephemeral: true });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Concordia project code registry")
      .setColor(0x5865f2)
      // `/projects` is a general lookup command. Keep local filesystem paths on the
      // manager-only registration confirmation while preserving the legacy visibility.
      .setDescription(clipProjectCodeList(
        result.project_codes.map((row) => `\`${row.code}\` ${row.project}`).join("\n"),
        MAX_EMBED_DESCRIPTION,
      ))
      .setFooter({ text: "正本: Concordia DB" });
    await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  },
};

export default projectsCommand;
