// @implements SPEC-PBUDGET-VIEW
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";

/**
 * /budget — 自分の個人の AI 予算 (spec/feature/personal-ai-budget.md §7)。
 *
 * 今月の月間分 (上限・使用・残り)、 報酬分の残り、 直近の履歴を本人にだけ返す (CC-PBUDGET-INV-08)。
 * 子会社 guild ではその会社の分、 本社 guild ではその人の全社分を出す。
 */
const budgetCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("budget")
    .setDescription("自分の AI 予算 (月間分と報酬分) を確認する (本人にだけ表示)"),
  async execute(interaction, deps) {
    const budget = deps.personalBudget;
    if (!budget) {
      await interaction.reply({ content: "個人の AI 予算はこの Bot で使えません。", ephemeral: true });
      return;
    }
    await interaction.reply({
      content: budget.renderBudget(interaction.user.id).slice(0, 1900),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  },
};

export default budgetCommand;
