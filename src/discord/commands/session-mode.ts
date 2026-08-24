/** @implements spec/feature/plan-gate.md §5 — Discord mode-switch entrypoint */
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const sessionModeCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-mode")
    .setDescription("このセッションの Vibes / Plan ルールを切り替える")
    .addStringOption((option) => option
      .setName("target")
      .setDescription("切替先")
      .setRequired(true)
      .addChoices(
        { name: "Vibes", value: "vibes" },
        { name: "Plan", value: "plan" },
      ))
    .addStringOption((option) => option
      .setName("reason")
      .setDescription("切替理由")
      .setMaxLength(1000)),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.options.getString("target", true) as "plan" | "vibes";
    const rationale = interaction.options.getString("reason")?.trim()
      || `Discord /co-mode by ${interaction.user.id}`;
    const result = await callConcordia<{ pending?: boolean; question_id?: number; contract?: unknown }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${encodeURIComponent(session.sessionId)}/contract/mode-switch`,
      { target, rationale },
    );
    if ("error" in result) {
      await interaction.editReply({ content: `モード切替に失敗しました: ${result.error}` });
      return;
    }
    await interaction.editReply({
      content: result.pending
        ? "Plan → Vibes の降格承認を依頼しました。承認されるまで Plan ルールを維持します。"
        : `セッションを **${target === "plan" ? "Plan" : "Vibes"}** ルールへ切り替えました。`,
    });
  },
};

export default sessionModeCommand;
