import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const answerCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("answer")
    .setDescription("Answer the latest pending question")
    .addIntegerOption((o) => o.setName("choice").setDescription("0-based option index").setRequired(true).setMinValue(0).setMaxValue(24)),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    const q = deps.pendingQuestionsRepo.findLatestUnanswered(session.sessionId);
    if (!q) {
      await interaction.reply({ content: "No pending question.", ephemeral: true });
      return;
    }
    const choice = interaction.options.getInteger("choice", true);
    const r = await callConcordia<{ ok: boolean; answer_text: string }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/answer-question`,
      { question_id: q.id, answer_index: choice },
    );
    if ("error" in r) {
      await interaction.reply({ content: `Answer failed: ${r.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Answered: ${r.answer_text}`, ephemeral: true });
  },
};

export default answerCommand;
