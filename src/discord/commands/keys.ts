import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const keysCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("keys")
    .setDescription("Send keys to session")
    .addStringOption((o) => o.setName("seq").setDescription("key sequence").setRequired(true).setMaxLength(200)),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    const seq = interaction.options.getString("seq", true);
    const r = await callConcordia<any>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/keys`,
      { seq },
    );
    if ("error" in r) {
      await interaction.reply({ content: `keys failed: ${r.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: "Keys sent.", ephemeral: true });
  },
};

export default keysCommand;
