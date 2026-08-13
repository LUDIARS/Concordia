import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { callConcordia } from "./commands/_util.js";

export const PLAN_PREFIX = "dirplan:";

export function renderPlanCard(input: { caseId: string; version: number; markdown: string }) {
  return {
    embeds: [new EmbedBuilder()
      .setTitle(`Design plan v${input.version}`)
      .setDescription(input.markdown.slice(0, 3500))
      .setFooter({ text: `Plan v${input.version}. Reply [A], [B] changes, or [C], or use the buttons.` })
      .setColor(0x5865f2)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PLAN_PREFIX}approve:${input.caseId}:${input.version}`).setLabel("[A] Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${PLAN_PREFIX}revise:${input.caseId}:${input.version}`).setLabel("[B] Revise").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PLAN_PREFIX}discard:${input.caseId}:${input.version}`).setLabel("[C] Discard").setStyle(ButtonStyle.Danger),
    )],
  };
}

export async function handlePlanButton(interaction: ButtonInteraction, base: string): Promise<void> {
  const [, action, caseId, versionText] = interaction.customId.split(":");
  const version = Number(versionText);
  if (!caseId || !Number.isInteger(version) || version < 1) {
    await interaction.reply({ content: "Invalid plan action.", ephemeral: true });
    return;
  }
  if (action === "revise") {
    const modal = new ModalBuilder()
      .setCustomId(`${PLAN_PREFIX}revise-modal:${caseId}:${version}:${interaction.message.id}`)
      .setTitle("Plan revision request")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("instruction").setLabel("Required changes").setStyle(TextInputStyle.Paragraph).setRequired(true),
      ));
    await interaction.showModal(modal);
    return;
  }
  await interaction.deferUpdate();
  const result = await callConcordia<{ error?: string }>(base, "POST", `/v1/director/cases/${caseId}/plan/action`, { action, version });
  await interaction.editReply({
    content: "error" in result ? `Plan action failed: ${result.error}` : action === "approve" ? "Approved. Implementation may proceed." : "Plan discarded.",
    embeds: interaction.message.embeds,
    components: [],
  });
}

export async function handlePlanModal(interaction: ModalSubmitInteraction, base: string): Promise<void> {
  const [, , caseId, versionText, messageId] = interaction.customId.split(":");
  const version = Number(versionText);
  const instruction = interaction.fields.getTextInputValue("instruction");
  await interaction.deferReply({ ephemeral: true });
  if (!caseId || !Number.isInteger(version) || version < 1) {
    await interaction.editReply({ content: "Invalid plan revision request." });
    return;
  }
  const result = await callConcordia<{ error?: string }>(base, "POST", `/v1/director/cases/${caseId}/plan/action`, { action: "revise", version, instruction });
  if (!("error" in result) && interaction.channelId && messageId) {
    const channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const oldCard = await channel.messages.fetch(messageId).catch(() => null);
      await oldCard?.edit({ content: "Revision requested; this plan card is superseded.", components: [] }).catch(() => undefined);
    }
  }
  await interaction.editReply({ content: "error" in result ? `Plan action failed: ${result.error}` : "Revision request sent to the assigned session." });
}
