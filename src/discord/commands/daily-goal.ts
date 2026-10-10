import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { describeMissing } from "../../daily-goal-run/confirmation-policy.js";
import type { GoalDraft } from "../../daily-goal-run/domain.js";
import type { ConfirmResult } from "../../daily-goal-run/service.js";

/**
 * /co-daily-goal — その日のデイリーゴールを確定する (spec/feature/daily-goal-run.md §2)。
 *
 * interaction の user 本人の操作で確定する。 欠けた項目は確定せず ephemeral で聞き返す。
 * 許可範囲 (merge / test / service / deploy) は 4 項目すべての明示が要る。
 */

/** 受入条件・task ID の区切り (改行または `;`)。 */
export function splitLines(raw: string | null): string[] {
  return (raw ?? "").split(/\r?\n|;/).map((value) => value.trim()).filter(Boolean);
}

export function splitIds(raw: string | null): string[] {
  return (raw ?? "").split(/[\s,;]+/).map((value) => value.trim().replace(/^actio:/, "")).filter(Boolean);
}

export function draftFromInteraction(interaction: Pick<ChatInputCommandInteraction, "options">): GoalDraft {
  const o = interaction.options;
  return {
    project: o.getString("project"),
    goalText: o.getString("goal"),
    acceptance: splitLines(o.getString("acceptance")),
    actioTaskIds: splitIds(o.getString("actio_tasks")),
    permissions: { merge: o.getBoolean("merge"), test: o.getBoolean("test"), service: o.getBoolean("service"), deploy: o.getBoolean("deploy") },
  };
}

export function confirmReply(result: ConfirmResult, launchAt: (goal: Extract<ConfirmResult, { ok: true }>["goal"]) => number): string {
  if (!result.ok) {
    if (result.kind === "missing") {
      return `デイリーゴールは確定していません。次の項目が足りません:\n${describeMissing(result.missing)}\n` +
        "受入条件・Actio task は改行か `;` 区切り、許可範囲は merge / test / service / deploy をすべて指定してください。";
    }
    return `デイリーゴールは確定していません: ${result.reason}`;
  }
  const at = new Date(launchAt(result.goal));
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const lead = result.created ? "デイリーゴールを確定しました" : "このゴールは確定済みです";
  return `${lead} (${result.goal.id})。専用セッションは ${time} に起動します。進み具合は「デイリーゴール」チャンネルのカードで確認できます。`;
}

const dailyGoalCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("co-daily-goal")
    .setDescription("その日のデイリーゴールを確定する (専用セッションが 1 時間ごとの確認を挟んで進める)")
    .addStringOption((o) => o.setName("project").setDescription("プロジェクト (名前またはコード)").setMaxLength(100))
    .addStringOption((o) => o.setName("goal").setDescription("ゴール文 (その日に達成する成果)").setMaxLength(1000))
    .addStringOption((o) => o.setName("acceptance").setDescription("受入条件 (改行か ; 区切り。確認で照合できる形)").setMaxLength(2000))
    .addStringOption((o) => o.setName("actio_tasks").setDescription("対応する Actio task ID (空白・, 区切り)").setMaxLength(1000))
    .addBooleanOption((o) => o.setName("merge").setDescription("マージを許可するか"))
    .addBooleanOption((o) => o.setName("test").setDescription("テストを許可するか"))
    .addBooleanOption((o) => o.setName("service").setDescription("サービス操作を許可するか"))
    .addBooleanOption((o) => o.setName("deploy").setDescription("反映を許可するか")),
  async execute(interaction, deps) {
    const port = deps.dailyGoals;
    if (!port?.isEnabled()) {
      await interaction.reply({ content: "デイリーゴール自走はこの Bot では使えません (ワークフロー無効または未配線)。", ephemeral: true });
      return;
    }
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.reply({ content: "サーバーのチャンネルから実行してください。", ephemeral: true });
      return;
    }
    const result = port.confirm({
      draft: draftFromInteraction(interaction),
      actor: { userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId, isBot: interaction.user.bot, isWebhook: false },
      receiptId: interaction.id,
    });
    await interaction.reply({ content: confirmReply(result, (goal) => port.launchAtFor(goal)), ephemeral: true, allowedMentions: { parse: [] } });
    if (result.ok && result.created) port.launchSoon();
  },
};

export default dailyGoalCommand;
