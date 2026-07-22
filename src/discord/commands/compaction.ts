import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

/**
 * /co-compaction — このセッションを引き継ぎ型コンパクションする。
 * 引き継ぎ資料をこのチャンネルへ投稿 → /clear → 資料を読んで続行。
 * spec/feature/session-compaction.md。
 */
const compactionCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-compaction")
    .setDescription("このセッションを引き継ぎ型コンパクション (資料投稿→/clear→続行)"),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.reply({ content: "🧹 コンパクションを開始します (引き継ぎ資料を生成→投稿→/clear→続行)…", ephemeral: true });
    const res = await callConcordia<{ ok: boolean; error?: string }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/compact`,
    );
    const ok = res && "ok" in res && res.ok;
    const err = res && "error" in res ? res.error : undefined;
    const msg = ok ? "✅ コンパクション完了。" : `⚠️ 失敗: ${err ?? "unknown"}`;
    await interaction.followUp({ content: msg, ephemeral: true });
  },
};

export default compactionCommand;
