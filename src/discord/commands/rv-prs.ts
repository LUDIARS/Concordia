import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia } from "./_util.js";

/**
 * /rv-prs — Revisor local PR の一覧。
 *
 * 「PR」は GitHub PR と誤解されがちだが、 LUDIARS の実装レビューは Revisor local PR
 * が正。 コマンド名と説明で「Revisor の PR」であることを明示し、 出力側の注記
 * (local-pr-listing.ts) と合わせて毎回教える。 GitHub PR のキューは /prs。
 */
const rvPrsCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("rv-prs")
    .setDescription("Revisor local PR の一覧 — LUDIARS で「PR」は原則こちら (GitHub PR は /prs)")
    .addStringOption((o) =>
      o.setName("repository")
        .setDescription("owner/repo で絞り込む (例 LUDIARS/Concordia)")
        .setRequired(false)),
  async execute(interaction, deps) {
    await interaction.deferReply({ ephemeral: true });
    const repository = interaction.options.getString("repository")?.trim() ?? "";
    const query = repository ? `?repository=${encodeURIComponent(repository)}` : "";
    const r = await callConcordia<{ markdown: string; open_count: number; error: string | null }>(
      deps.concordiaUrl,
      "GET",
      `/v1/prs/revisor/digest${query}`,
    );
    if (typeof r !== "object" || r === null || !("markdown" in r) || typeof r.markdown !== "string") {
      await interaction.editReply({
        content: "Revisor local PR 一覧の取得に失敗しました。Concordia の状態を確認してください。",
        allowedMentions: { parse: [] },
      });
      return;
    }
    const md = r.markdown.slice(0, 1900);
    await interaction.editReply({ content: md || "(empty)", allowedMentions: { parse: [] } });
  },
};

export default rvPrsCommand;
