import {
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import type { DiscordCommandDeps, DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";

const MODAL_ID_PREFIX = "inject_modal:";
const FIELD_ID = "inject_text";

const injectCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("inject")
    .setDescription("Inject text into the current session")
    .addStringOption((o) => o.setName("text").setDescription("Text").setMaxLength(4000).setRequired(false)),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    const text = interaction.options.getString("text");
    if (!text) {
      const modal = new ModalBuilder()
        .setCustomId(`${MODAL_ID_PREFIX}${session.sessionId}`)
        .setTitle("Inject Message");
      const input = new TextInputBuilder()
        .setCustomId(FIELD_ID)
        .setLabel("Message")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }
    const r = await callConcordia<{ ok: boolean }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/inject`,
      { text },
    );
    if ("error" in r) {
      await interaction.reply({ content: `Inject failed: ${r.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: "Injected.", ephemeral: true });
  },
};

export async function dispatchModalSubmit(interaction: ModalSubmitInteraction, deps: DiscordCommandDeps): Promise<void> {
  if (!interaction.customId.startsWith(MODAL_ID_PREFIX)) return;
  const sessionId = interaction.customId.slice(MODAL_ID_PREFIX.length);
  const text = interaction.fields.getTextInputValue(FIELD_ID)?.trim();
  if (!text) {
    await interaction.reply({ content: "Text is empty.", ephemeral: true });
    return;
  }
  const r = await callConcordia<{ ok: boolean }>(
    deps.concordiaUrl,
    "POST",
    `/v1/sessions/${sessionId}/inject`,
    { text },
  );
  if ("error" in r) {
    await interaction.reply({ content: `Inject failed: ${r.error}`, ephemeral: true });
    return;
  }
  await interaction.reply({ content: "Injected.", ephemeral: true });
}

export default injectCommand;
