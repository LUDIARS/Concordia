import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type Interaction, type Message } from "discord.js";
import { action, assertHumanChoice } from "../sprint-dialogues/domain.js";
import type { SprintDialoguesRepository } from "../sprint-dialogues/repository.js";
import { choiceLabels } from "./sprint-dialogues-card.js";

export function sprintDialogueInput(input: { repo: SprintDialoguesRepository; guildId: string; botId: string; allowed?: (userId: string) => boolean; stopped: () => boolean }) {
  const { repo } = input;
  return {
    handlesMessage: (m: Message) => m.guildId === input.guildId && !!repo.byThread(m.channelId),
    async message(m: Message): Promise<void> {
      if (input.stopped() || m.author.bot || m.webhookId || m.guildId !== input.guildId) return;
      const d = repo.byThread(m.channelId);
      if (!d) return;
      const reply = (content: string) => m.reply({ content, allowedMentions: { parse: [] } });
      if (input.allowed?.(m.author.id) !== true) { await reply("相談の受付にはCcのセッション起動権限が必要です。フェーズ判断はActioで本人とチーム権限を確認します。"); return; }
      const prompt = m.content.trim();
      if (!prompt || prompt.length > 4000) { await reply("相談内容を4000字以内の文章で投稿してください。"); return; }
      try { repo.enqueueConversation(`discord:${m.guildId}:${m.id}`, d.id, prompt, Date.now()); await m.react("📨"); }
      catch (error) { await reply(String(error).slice(0, 1500)); }
    },
    handlesInteraction: (i: Interaction) => (i.isButton() && i.customId.startsWith("sd:")) || (i.isModalSubmit() && i.customId.startsWith("sdm:")),
    async interaction(i: Interaction): Promise<void> {
      if ((!i.isButton() && !i.isModalSubmit()) || input.stopped()) return;
      if (i.guildId !== input.guildId || !i.channelId || i.user.bot || input.allowed?.(i.user.id) !== true) { await i.reply({ content: "このスプリント回答を受け付ける権限を確認できません。", ephemeral: true }); return; }
      if (i.isButton()) {
        try {
          const match = /^sd:([0-9a-f]{24}):(\d+):(approve|reject|hold|resume|resubmit)$/.exec(i.customId);
          if (!match || i.message.author.id !== input.botId || i.message.webhookId) throw new Error("確認カードを検証できません。");
          const d = repo.byId(match[1]!);
          if (!d || d.cardId !== i.message.id) throw new Error("現在の確認カードではありません。");
          assertHumanChoice(d, Number(match[2]), i.channelId, i.guildId);
          const selected = action.parse(match[3]);
          const ticket = randomUUID();
          repo.issueChoice({ id: ticket, dialogueId: d.id, userId: i.user.id, guildId: i.guildId, threadId: i.channelId, revision: d.projection.revision, action: selected, expiresAt: Date.now() + 600000 });
          const modal = new ModalBuilder().setCustomId(`sdm:${ticket}`).setTitle(`${choiceLabels[selected]} / 版 ${d.projection.revision}`);
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("判断の理由・確認した内容").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)));
          if (selected === "reject") modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("taskIds").setLabel("未達のタスクID（カンマ・空白区切り）").setStyle(TextInputStyle.Paragraph).setRequired(d.projection.phase !== "planning").setMaxLength(2000)));
          await i.showModal(modal);
        } catch (error) { await i.reply({ content: String(error).slice(0, 1500), ephemeral: true }); }
        return;
      }
      await i.deferReply({ ephemeral: true });
      try {
        const reason = i.fields.getTextInputValue("reason").trim();
        if (!reason || reason.length > 2000) throw new Error("判断理由を入力してください。");
        const taskIds = [...new Set((i.fields.fields.has("taskIds") ? i.fields.getTextInputValue("taskIds") : "").split(/[,\s]+/).filter(Boolean))];
        repo.consumeChoice(i.customId.slice(4), { eventId: `discord:${i.guildId}:${i.id}`, userId: i.user.id, guildId: i.guildId, threadId: i.channelId, reason, taskIds, now: Date.now() });
        await i.editReply("回答を保存しました。Actioで本人・チーム権限と対象版を確認中です。反映結果はこのスレッドへ通知します。");
      } catch (error) { await i.editReply(String(error).slice(0, 1500)); }
    },
  };
}
