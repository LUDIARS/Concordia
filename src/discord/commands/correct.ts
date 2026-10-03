// @implements SPEC-DLG-CORRECTIONS
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

/**
 * /co-correct — 部署セッションの回答に対する「人の訂正」を登録する
 * (spec/feature/dialogue-context.md §6)。
 *
 * 訂正はセッションの部署のユースケースへ、 会社・部署・セッション・登録者を添えて蓄積され、
 * 以後の同じ会社の対話で事前データに並ぶ。 以後の回答を左右するので、 起動権限を持つ人だけが
 * 登録できる (権限を判定できない構成では登録させない)。
 */
const REASON_MESSAGES: Record<string, string> = {
  session_has_no_department: "このセッションは部署に属していないため、訂正の登録先がありません。",
  department_has_no_use_case: "このセッションの部署にはユースケースが無いため、訂正の登録先がありません。",
  use_case_archived: "この部署のユースケースは廃止されているため、訂正を登録できません。",
  session_not_found: "セッションが見つかりません。",
};

const correctCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-correct")
    .setDescription("このセッションの回答への訂正を登録し、以後の回答の前提にする")
    .addStringOption((o) =>
      o.setName("correction").setDescription("正しい内容").setRequired(true).setMaxLength(4000),
    )
    .addStringOption((o) =>
      o.setName("question").setDescription("何についての訂正か (任意)").setMaxLength(1000),
    ),
  async execute(interaction, deps) {
    if (deps.isSessionControlUserAllowed?.(interaction.user.id) !== true) {
      await interaction.reply({ content: "訂正を登録する権限がありません。", ephemeral: true });
      return;
    }
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.deferReply({ ephemeral: true });
    const res = await callConcordia<{ correction: { id: string } }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/corrections`,
      {
        correction: interaction.options.getString("correction", true),
        question: interaction.options.getString("question") ?? "",
        author: interaction.user.id,
        source: "discord",
      },
    );
    if ("error" in res) {
      await interaction.editReply({ content: `⚠️ ${REASON_MESSAGES[res.error] ?? "訂正を登録できませんでした。"}` });
      return;
    }
    await interaction.editReply({ content: "📝 訂正を登録しました。以後のこの部署の回答で前提として使われます。" });
  },
};

export default correctCommand;
