import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

/**
 * /co-effort — このセッションの effort を途中で変える (spec/feature/effort-movable.md)。
 * 変更に成功するとセッションのスレッドへ Cc が通知を投稿する (本人への返答は ephemeral)。
 * 費用に直結するため起動権限 (管理職以上) と同じ扱いにする (commands.ts の権限分類)。
 */
const effortCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-effort")
    .setDescription("このセッションの effort を途中で変更する")
    .addStringOption((o) =>
      o
        .setName("level")
        .setDescription("新しい effort")
        .setRequired(true)
        .addChoices(
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh", value: "xhigh" },
          { name: "max (Claude のみ)", value: "max" },
        ),
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("変更の理由 (通知に載ります)").setMaxLength(500),
    ),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.deferReply({ ephemeral: true });
    const level = interaction.options.getString("level", true);
    const reason = interaction.options.getString("reason")?.trim() || "Discord の /co-effort による変更";
    const res = await callConcordia<{ ok: boolean; changed: boolean; effort: string; previous: string | null }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/effort`,
      {
        effort: level,
        actor: "human",
        reason,
        requested_by: interaction.user.globalName?.trim() || interaction.user.username,
      },
    );
    if ("error" in res) {
      await interaction.editReply({ content: `⚠️ effort を変更できませんでした: ${res.error}` });
      return;
    }
    await interaction.editReply({
      content: res.changed
        ? `🎚️ effort を ${res.previous ?? "(不明)"} → ${res.effort} に変更しました。`
        : `🎚️ effort は既に ${res.effort} です。`,
    });
  },
};

export default effortCommand;
