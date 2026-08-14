import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

/**
 * /co-handover — このセッションの作業を次のセッションへ移行する (自動引き継ぎ)。
 *
 * /co-compaction が「同一セッションで /clear して続行」なのに対し、 こちらは
 * 「セッション自身が引き継ぎ資料を書く → 新セッションを spawn → このセッションを終了 →
 * 新セッションが資料を読んで続行」。 session id とチャンネルは新しくなる。
 * spec/tasks/2026-08-14-handover-command.md。
 */
const handoverCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-handover")
    .setDescription("次のセッションへ移行 (自筆引き継ぎ資料→新セッション spawn→このセッション終了)"),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.reply({
      content: "🤝 次のセッションへ移行します (引き継ぎ資料を自筆→新セッション spawn→このセッション終了)…",
      ephemeral: true,
    });
    const res = await callConcordia<{ ok: boolean; error?: string }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/handover`,
    );
    if ("error" in res) {
      await interaction.followUp({ content: `⚠️ 失敗: ${res.error}`, ephemeral: true });
      return;
    }
    await interaction.followUp({
      content: "✅ 次のセッションを起動しました。引き継ぎ資料を読んで続行します。このチャンネルは間もなく終了します。",
      ephemeral: true,
    });
  },
};

export default handoverCommand;
