import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia } from "./_util.js";

// @implements spec/feature/domain-review-discord.md §2.1, §2.4 — /domain-review

interface DomainReviewResponse {
  posted: boolean;
  reason?: string;
  source?: "prepared" | "raw";
  core_domains?: number;
  layers?: number;
  layer_violations?: number;
  plan_questions?: number;
  image_attached?: boolean;
}

/** 見送り理由を、次に何をすればよいかが分かる日本語にする。 */
const SKIP_MESSAGE: Record<string, string> = {
  project_not_registered: "その略称の project code 登録がありません (`/projects` で確認してください)。",
  domain_review_disabled: "このプロジェクトはドメインレビュー対象外です (WebUI のプロジェクトコード画面で ON にできます)。",
  anatomia_project_unknown: "Anatomia にこのリポジトリの登録がありません。",
  anatomia_unreachable: "Anatomia の warm server に繋がりません。",
  not_prepared: "Anatomia の web-cache が未 prepare です (prepare 後に再実行してください)。",
  no_domain_data: "出せるドメイン情報がありませんでした。",
  post_failed: "Discord への投稿に失敗しました。",
};

const domainReviewCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("domain-review")
    .setDescription("対象プロジェクトのドメイン情報 (コア / 層 / 層違反) をこのチャンネルへ投稿")
    .addStringOption((option) => option
      .setName("code")
      .setDescription("プロジェクトコード (例 Cc)")
      .setRequired(true)
      .setMaxLength(64)),
  async execute(interaction, deps) {
    // Anatomia 読み取り + 画像化で 3 秒を超えることがあるので必ず defer する。
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString("code", true).trim();
    const result = await callConcordia<DomainReviewResponse>(
      deps.concordiaUrl,
      "POST",
      "/v1/domain-review",
      { trigger: "manual", code, channel_id: interaction.channelId },
    );
    if ("error" in result) {
      await interaction.editReply({ content: `domain-review failed: ${result.error}` });
      return;
    }
    if (!result.posted) {
      const reason = result.reason ?? "unknown";
      await interaction.editReply({ content: SKIP_MESSAGE[reason] ?? `投稿しませんでした (${reason})。` });
      return;
    }
    await interaction.editReply({
      content: [
        `\`${code}\` のドメイン情報を投稿しました`,
        `(コアドメイン ${result.core_domains ?? 0} / 層 ${result.layers ?? 0}`,
        `/ 層違反 ${result.layer_violations ?? 0}`,
        result.plan_questions ? `/ plan の問い ${result.plan_questions}` : "",
        result.source === "raw" ? "/ 未 prepare のため簡易表示" : "",
        result.image_attached ? "/ 層図あり" : "",
        ")",
      ].filter(Boolean).join(" "),
    });
  },
};

export default domainReviewCommand;
