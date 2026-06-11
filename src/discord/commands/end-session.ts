import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const endSessionCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder().setName("end-session").setDescription("End current session"),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.reply({ content: "Session end requested.", ephemeral: true });
    void callConcordia<{ ok: boolean }>(deps.concordiaUrl, "DELETE", `/v1/sessions/${session.sessionId}`);
  },
};

export default endSessionCommand;
