import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

interface SkillListResponse {
  ok: boolean;
  branch: string | null;
  requested_branch?: string | null;
  branch_mismatch?: boolean;
  skills: Array<{ name: string; relativePath: string }>;
}

interface SkillInvokeResponse {
  ok: boolean;
  name: string;
  source: string;
  branch: string | null;
  sidecar_loaded?: boolean;
  sidecar_warning?: string | null;
}

const ccSkillCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("cc-skill")
    .setDescription("この Session の現在の作業ブランチにある skill を呼び出す")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("worktree 内の skill 名")
        .setRequired(true)
        .setAutocomplete(true)),

  async autocomplete(interaction, deps) {
    const row = deps.sessionChannelsRepo.findByChannelId(interaction.channelId);
    if (!row) {
      await interaction.respond([]);
      return;
    }
    const result = await callConcordia<SkillListResponse>(
      deps.concordiaUrl,
      "GET",
      `/v1/sessions/${encodeURIComponent(row.session_id)}/skills`,
    );
    if ("error" in result) {
      deps.log.warn(`cc-skill autocomplete failed session=${row.session_id}: ${result.error}`);
      await interaction.respond([]);
      return;
    }
    if (result.branch_mismatch) {
      deps.log.warn(
        `cc-skill autocomplete blocked branch mismatch session=${row.session_id} ` +
        `requested=${result.requested_branch ?? "-"} actual=${result.branch ?? "-"}`,
      );
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused().trim().toLowerCase();
    await interaction.respond(
      result.skills
        .filter((skill) => !focused || skill.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((skill) => ({
          name: `${skill.name} — ${skill.relativePath}`.slice(0, 100),
          value: skill.name,
        })),
    );
  },

  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    const name = interaction.options.getString("name", true).trim();
    await interaction.deferReply({ ephemeral: true });
    const result = await callConcordia<SkillInvokeResponse>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${encodeURIComponent(session.sessionId)}/skill`,
      { name },
    );
    if ("error" in result) {
      await interaction.editReply({ content: `⚠️ /cc-skill 失敗: ${result.error}` });
      return;
    }
    await interaction.editReply({
      content:
        `✅ \`${result.name}\` をこの Session に注入しました。\n` +
        `branch: \`${result.branch ?? "(detached)"}\` / source: \`${result.source}\`` +
        (result.sidecar_warning
          ? `\n注: sidecar への永続化は省略されました（${result.sidecar_warning}）。今回の呼び出しには適用済みです。`
          : ""),
    });
  },
};

export default ccSkillCommand;
