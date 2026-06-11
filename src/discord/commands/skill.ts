import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const fallback = ["pending-tasks", "conflicts", "session-state"];

const skillCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("skill")
    .setDescription("Run Lictor skill proxy")
    .addStringOption((o) => o.setName("name").setDescription("skill name").setRequired(true)),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    const name = interaction.options.getString("name", true);
    await interaction.deferReply({ ephemeral: true });
    const r = await callConcordia<any>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/skill`,
      { name },
    );
    if ("error" in r) {
      await interaction.editReply({ content: `skill failed: ${r.error}` });
      return;
    }
    await interaction.editReply({ content: "Skill command sent." });
  },
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = fallback
      .filter((x) => x.includes(focused))
      .slice(0, 25)
      .map((x) => ({ name: x, value: x }));
    await interaction.respond(choices);
  },
};

export default skillCommand;
