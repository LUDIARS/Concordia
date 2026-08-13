import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { callConcordia } from "./_util.js";

const prsCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("prs")
    .setDescription("GitHub PR のキューを表示する — Revisor local PR は /rv-prs (通常「PR」はそちら)"),
  async execute(interaction, deps) {
    await interaction.deferReply({ ephemeral: true });
    const r = await callConcordia<{ markdown: string }>(
      deps.concordiaUrl,
      "GET",
      "/v1/prs/digest",
    );
    if ("error" in r) {
      await interaction.editReply({ content: `pr queue failed: ${r.error}` });
      return;
    }
    const md = (r.markdown ?? "(empty)").slice(0, 1900);
    await interaction.editReply({ content: md });
  },
};

export default prsCommand;
