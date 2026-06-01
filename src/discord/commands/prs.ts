import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";

const prsCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("prs")
    .setDescription("各セッションが作った PR のキューを表示する"),
  async execute(interaction, deps) {
    const r = await callConcordia<{ markdown: string }>(
      deps.concordiaUrl,
      "GET",
      "/v1/prs/digest",
    );
    if ("error" in r) {
      await interaction.reply({ content: `pr queue failed: ${r.error}`, ephemeral: true });
      return;
    }
    const md = (r.markdown ?? "(empty)").slice(0, 1900);
    await interaction.reply({ content: md, ephemeral: true });
  },
};

export default prsCommand;
