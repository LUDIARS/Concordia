import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type Interaction } from "discord.js";
import { meetingLinkConfig } from "./config.js";
import type { MeetingLinkStore } from "./store.js";
import { eligibleMeetingMember } from "./policy.js";

export function isMeetingLinkInteraction(interaction: Interaction): boolean {
  return interaction.isButton() && interaction.customId.startsWith("aedilis:respond:");
}
/** Only a live guild member clicking this application's announcement can mint a respondent link. */
export async function handleMeetingLinkInteraction(interaction: Interaction, store: MeetingLinkStore): Promise<void> {
  if (!interaction.isButton()) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const config = meetingLinkConfig();
    const meetingId = interaction.customId.slice("aedilis:respond:".length);
    if (!config || !interaction.guild || interaction.guildId !== config.guildId || interaction.user.bot
      || !/^[0-9a-f-]{36}$/i.test(meetingId)) {
      await interaction.editReply("この組織では本人用の回答リンクを発行できません。"); return;
    }
    const meetingUrl = config.audience + "/meeting/" + meetingId;
    const ownMessage = interaction.message.author.id === interaction.client.user.id
      || interaction.message.applicationId === interaction.applicationId;
    if (!ownMessage || !interaction.message.embeds.some(embed => embed.url === meetingUrl)) {
      await interaction.editReply("正式な予定案内から回答ボタンを押してください。"); return;
    }
    // Force a REST read: cached membership must not admit a departed/pending member.
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (!eligibleMeetingMember({ id: member.id, pending: member.pending, bot: member.user.bot }, interaction.user.id)) {
      await interaction.editReply("組織への参加が完了したアカウントだけが利用できます。"); return;
    }
    const displayName = member.displayName.trim().slice(0, 80) || interaction.user.username.slice(0, 80);
    const code = store.issue({ meetingId, guildId: config.guildId, audience: config.audience,
      discordUserId: interaction.user.id, displayName });
    const url = meetingUrl + "#discord_handoff=" + code;
    await interaction.editReply({ content: displayName + " さん本人の回答リンクです。5分間・1回限り、この予定への回答だけに使えます。他の人に共有しないでください。",
      allowedMentions: { parse: [] }, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("本人として回答ページを開く").setURL(url))] });
  } catch {
    // Do not log Discord interaction credentials or issued bearer links.
    await interaction.editReply({ content: "所属確認またはリンク発行に失敗しました。少し待って回答ボタンを押し直してください。", components: [] });
  }
}
