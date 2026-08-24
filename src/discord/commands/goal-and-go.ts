/** @implements spec/feature/goal-and-go.md — Discord session command */
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

interface GoalAndGoResponseStatus {
  enabled: boolean;
  continuation_count: number;
  stopped_reason: "continuation_limit" | "runtime_limit" | null;
}

const goalAndGoCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-go-and-go")
    .setDescription("このセッションの Goal & Go を表示または切り替える")
    .addStringOption((option) => option
      .setName("state")
      .setDescription("切替先。省略すると現在値を表示")
      .addChoices(
        { name: "ON", value: "on" },
        { name: "OFF", value: "off" },
      )),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.deferReply({ ephemeral: true });
    const state = interaction.options.getString("state");
    const path = `/v1/sessions/${encodeURIComponent(session.sessionId)}/goal-and-go`;
    const result = state
      ? await callConcordia<{ ok: boolean; goal_and_go: GoalAndGoResponseStatus }>(
          deps.concordiaUrl,
          "POST",
          path,
          { enabled: state === "on" },
        )
      : await callConcordia<{ goal_and_go: GoalAndGoResponseStatus }>(deps.concordiaUrl, "GET", path);
    if ("error" in result) {
      await interaction.editReply({ content: `Goal & Go の操作に失敗しました: ${result.error}` });
      return;
    }
    const status = result.goal_and_go;
    await interaction.editReply({
      content: `Goal & Go: **${status.enabled ? "ON" : "OFF"}**` +
        ` (continuations: ${status.continuation_count}` +
        `${status.stopped_reason ? `, stopped: ${status.stopped_reason}` : ""})`,
    });
  },
};

export default goalAndGoCommand;
