import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";

const consultationCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("consultation")
    .setDescription("Post to consultation")
    .addStringOption((o) => o.setName("text").setDescription("message").setRequired(true).setMaxLength(2000)),
  async execute(interaction, deps) {
    const text = interaction.options.getString("text", true);
    const author = interaction.user.username;
    const r = await callConcordia<{ ok: boolean }>(deps.concordiaUrl, "POST", "/v1/chat", {
      channel: "consultation",
      text,
      author_label: author,
      metadata: { source: "discord", discord_user_id: interaction.user.id },
    });
    if ("error" in r) {
      await interaction.reply({ content: `post failed: ${r.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: "Posted.", ephemeral: true });
  },
};

export default consultationCommand;
