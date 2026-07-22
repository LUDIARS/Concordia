import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

/**
 * /co-relictor — このセッションを最新版 Lictor で再起動する (文脈引き継ぎ)。
 * Lictor は claude を pty 子に抱えるため単体再 exec できない → ラップ中セッションごと
 * 再起動する。引き継ぎ資料を生成・投稿 → 新セッション spawn (最新 dist) → 旧セッション終了。
 * 新セッションは引き継ぎ資料を読んで文脈を復元して続行する。session id とチャンネルは新しくなる。
 */
const relictorCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-relictor")
    .setDescription("このセッションを最新版 Lictor で再起動 (文脈引き継ぎ・新セッション spawn)"),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.reply({
      content: "🔁 最新 Lictor で再起動します (引き継ぎ資料を生成→新セッション spawn→このセッション終了)…",
      ephemeral: true,
    });
    const res = await callConcordia<{ ok: boolean; error?: string }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/relictor`,
    );
    if ("error" in res) {
      await interaction.followUp({ content: `⚠️ 失敗: ${res.error}`, ephemeral: true });
      return;
    }
    await interaction.followUp({
      content: "✅ 新セッションを起動しました。引き継ぎ資料を読んで続行します。このチャンネルは間もなく終了します。",
      ephemeral: true,
    });
  },
};

export default relictorCommand;
