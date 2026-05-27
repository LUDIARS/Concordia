import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";

const statCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder().setName("stat").setDescription("Show current Concordia stats"),
  async execute(interaction, deps) {
    const r = await callConcordia<any>(deps.concordiaUrl, "GET", "/v1/stat");
    if ("error" in r) {
      await interaction.reply({ content: `stat failed: ${r.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: "```json\n" + JSON.stringify(r, null, 2).slice(0, 1900) + "\n```", ephemeral: true });
  },
};

export default statCommand;
