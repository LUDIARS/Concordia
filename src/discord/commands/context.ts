import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, type ButtonInteraction } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { requireSessionChannel } from "./_util.js";
import { buildContextReport } from "../context-report.js";

export const CONTEXT_COMPACT_PREFIX = "context:compact:";

/**
 * 「いまコンパクションする」ボタン。 customId からセッションを解決し、
 * Concordia API へ compact を依頼して結果を ephemeral で返す。
 * (commands.ts のインライン実装から抽出 — 挙動は同一。)
 */
export async function handleContextCompactButton(
  interaction: ButtonInteraction,
  deps: {
    sessionsRepo: { findSession(id: string): unknown };
    concordiaUrl: string;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sessionId = interaction.customId.slice(CONTEXT_COMPACT_PREFIX.length).trim();
  if (!sessionId || !deps.sessionsRepo.findSession(sessionId)) {
    await interaction.reply({ content: "対象セッションが見つかりません。", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  const result = await doFetch(`${deps.concordiaUrl.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/compact`, { method: "POST" });
  const payload = await result.json().catch(() => ({})) as { error?: string };
  await interaction.followUp({ content: result.ok ? "✅ コンパクション完了。" : `⚠️ 失敗: ${payload.error ?? result.status}`, ephemeral: true });
}

const contextCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder().setName("co-context").setDescription("現在のコンテキスト占有と残量を再推定"),
  async execute(interaction, deps) {
    const link = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!link) return;
    const session = deps.sessionsRepo.findSession(link.sessionId);
    if (!session) {
      await interaction.reply({ content: "対象セッションが見つかりません。", ephemeral: true });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONTEXT_COMPACT_PREFIX}${session.id}`)
        .setLabel("いまコンパクションする")
        .setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({ content: await buildContextReport(session), components: [row], ephemeral: true });
  },
};

export default contextCommand;
