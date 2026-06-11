import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";

const statCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder().setName("stat").setDescription("Show current Concordia stats"),
  async execute(interaction, deps) {
    await interaction.deferReply({ ephemeral: true });
    const r = await callConcordia<any>(deps.concordiaUrl, "GET", "/v1/stat");
    if ("error" in r) {
      await interaction.editReply({ content: `stat failed: ${r.error}` });
      return;
    }
    await interaction.editReply({ content: "```json\n" + JSON.stringify(r, null, 2).slice(0, 1900) + "\n```" });
  },
};

export default statCommand;
