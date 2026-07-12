import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";
import { describeGoal, type Goal } from "../../control/goal.js";

/**
 * /co-goal — このセッションのゴールを表示/変更する。
 * 引数なし=現在のゴール表示。 mode / text 指定で変更。
 * ゴールは作業モード・確認頻度を表示/変更する (complete=完成まで / scoped=範囲限定 /
 * watch=様子見・確認しながら)。 spec: review/design-2026-06-27-goal-system…。
 */
const goalCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-goal")
    .setDescription("このセッションのゴールを表示/変更する (既定: 完成まで実装)")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("ゴール種別")
        .addChoices(
          { name: "完成まで実装 (complete)", value: "complete" },
          { name: "範囲限定 (scoped)", value: "scoped" },
          { name: "様子見・確認しながら (watch)", value: "watch" },
        ),
    )
    .addStringOption((o) =>
      o.setName("text").setDescription("範囲や条件の自由文 (例: 月内目標 #441 まで)").setMaxLength(500),
    ),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.deferReply({ ephemeral: true });
    const mode = interaction.options.getString("mode") ?? undefined;
    const text = interaction.options.getString("text") ?? undefined;

    // 引数なし → 現在のゴールを表示。
    if (!mode && !text) {
      const res = await callConcordia<{ goal: Goal }>(
        deps.concordiaUrl,
        "GET",
        `/v1/sessions/${session.sessionId}/goal`,
      );
      if ("error" in res) {
        await interaction.editReply({ content: `⚠️ 取得失敗: ${res.error}` });
        return;
      }
      await interaction.editReply({ content: `🎯 現在のゴール: ${describeGoal(res.goal)}` });
      return;
    }

    const res = await callConcordia<{ ok: boolean; goal: Goal }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/goal`,
      { mode, text },
    );
    if ("error" in res) {
      await interaction.editReply({ content: `⚠️ 設定失敗: ${res.error}` });
      return;
    }
    await interaction.editReply({ content: `🎯 ゴールを設定しました: ${describeGoal(res.goal)}` });
  },
};

export default goalCommand;
