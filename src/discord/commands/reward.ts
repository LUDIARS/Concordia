// @implements SPEC-PBUDGET-ADJUST
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";

/**
 * /reward — 本社の調整「〇〇に報酬」(spec/feature/personal-ai-budget.md §6)。
 *
 * 本社 guild だけに出す。 操作できるのは社員名簿の権限者 (管理職以上) で、 理由は必須。
 * `tokens` が負なら減額 (残高は 0 まで)。 対象は子会社に所属する個人で、 複数の子会社に居る人は
 * `subsidiary` を指定する。 可否の判断は use case が行い、 ここは入力を渡して結果を本人にだけ返す。
 */
const MAX_TOKENS = 1_000_000_000;
/** Discord の autocomplete は 25 件まで。 */
const MAX_CHOICES = 25;

const rewardCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("reward")
    .setDescription("子会社の個人の AI 予算 (報酬分) を増減する (本社の権限者のみ)")
    .addUserOption((o) => o.setName("user").setDescription("対象の人").setRequired(true))
    .addIntegerOption((o) => o.setName("tokens").setDescription("増減するトークン数 (負で減額、残高は 0 まで)")
      .setRequired(true).setMinValue(-MAX_TOKENS).setMaxValue(MAX_TOKENS))
    .addStringOption((o) => o.setName("reason").setDescription("理由 (必須、台帳に残る)").setRequired(true).setMaxLength(500))
    .addStringOption((o) => o.setName("subsidiary").setDescription("対象の子会社 (複数の子会社に居る人のとき)")
      .setRequired(false).setAutocomplete(true)),
  async execute(interaction, deps) {
    const budget = deps.personalBudget;
    // 子会社 guild には登録しないが、 残った登録から届いても本社以外では受けない。
    if (!budget || deps.subsidiaryId) {
      await interaction.reply({ content: "報酬の調整は本社のサーバでだけ使えます。", ephemeral: true });
      return;
    }
    const target = interaction.options.getUser("user", true);
    // 所属の確認で Discord へ問い合わせるので、 先に本人にだけ見える形で受け付ける。
    await interaction.deferReply({ ephemeral: true });
    const content = await budget.reward({
      actorUserId: interaction.user.id,
      targetUserId: target.id,
      targetLabel: target.globalName ?? target.username,
      tokens: interaction.options.getInteger("tokens", true),
      reason: interaction.options.getString("reason", true),
      subsidiaryId: interaction.options.getString("subsidiary")?.trim() || null,
    });
    await interaction.editReply({ content: content.slice(0, 1900), allowedMentions: { parse: [] } });
  },
  async autocomplete(interaction, deps) {
    const query = interaction.options.getFocused().toString().trim();
    const choices = deps.subsidiaryId ? [] : deps.personalBudget?.subsidiaryChoices() ?? [];
    await interaction.respond(choices
      .filter((choice) => !query || choice.name.includes(query))
      .slice(0, MAX_CHOICES)
      .map((choice) => ({ name: choice.name.slice(0, 100), value: choice.id })));
  },
};

export default rewardCommand;
