import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { clipProjectCodeList } from "../project-code-view.js";
import { callConcordia } from "./_util.js";

interface ProjectCodeView {
  code: string;
  project: string;
  repo_path: string;
}

interface ProjectCodesResponse {
  project_codes: ProjectCodeView[];
}

interface ProjectCodeRegistrationResponse {
  project_code: ProjectCodeView;
  created: boolean;
}

const MAX_MESSAGE_CONTENT = 1_900;

const projectCodeCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("project-code")
    .setDescription("Concordia の project code registry を操作")
    .addSubcommand((command) => command.setName("list").setDescription("現在の登録一覧を表示"))
    .addSubcommand((command) => command
      .setName("add")
      .setDescription("workspace 内の Git repository を project code として登録")
      .addStringOption((option) => option
        .setName("code")
        .setDescription("大文字小文字を区別する project code (例: MN)")
        .setRequired(true))
      .addStringOption((option) => option
        .setName("repo")
        .setDescription("repository またはその配下の絶対パス")
        .setRequired(true))),

  async execute(interaction, deps) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "list") {
      const result = await callConcordia<ProjectCodesResponse>(deps.concordiaUrl, "GET", "/v1/project-codes");
      if ("error" in result) {
        await interaction.reply({
          content: `⚠️ project code 一覧取得失敗: ${result.error}`,
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const content = result.project_codes.length === 0
        ? "project code はまだ登録されていません。"
        : result.project_codes.map((row) => `\`${row.code}\` ${row.project}`).join("\n");
      await interaction.reply({
        content: clipProjectCodeList(content, MAX_MESSAGE_CONTENT),
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const code = interaction.options.getString("code", true).trim();
    const repoPath = interaction.options.getString("repo", true).trim();
    await interaction.deferReply({ ephemeral: true });
    const result = await callConcordia<ProjectCodeRegistrationResponse>(
      deps.concordiaUrl,
      "POST",
      "/v1/project-codes",
      { code, repo_path: repoPath, added_by: `discord:${interaction.user.id}` },
    );
    if ("error" in result) {
      await interaction.editReply({
        content: `⚠️ project code 登録失敗: ${result.error}`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.editReply({
      content: `${result.created ? "✅ 登録しました" : "✅ 登録済みです"}: `
        + `\`${result.project_code.code}\` → ${result.project_code.project}\n${result.project_code.repo_path}`,
      allowedMentions: { parse: [] },
    });
  },
};

export default projectCodeCommand;
