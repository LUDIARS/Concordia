import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { isForumSessionThread, updateForumSessionState } from "../forum-session.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const endSessionCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder().setName("end-session").setDescription("End current session"),
  async execute(interaction, deps) {
    await interaction.deferReply({ ephemeral: true });
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.editReply({ content: "Session end requested." });
    void callConcordia<{ ok: boolean }>(deps.concordiaUrl, "DELETE", `/v1/sessions/${session.sessionId}`);
    if (isForumSessionThread(interaction.channel)) {
      try {
        await updateForumSessionState(interaction.channel, "ended");
      } catch (error) {
        deps.log.warn(`end-session forum close failed channel=${interaction.channelId}: ${(error as Error).message}`);
      }
    }
  },
};

export default endSessionCommand;
