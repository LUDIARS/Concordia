import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { requireSessionChannel } from "./_util.js";
import { onSessionChannelNameLocked } from "../session-channel.js";

/**
 * /ch_name <name> — このセッションチャンネルの名前を <name> に固定する。
 *
 * 既定では title_renamed (リアクション rename 含む = 処理内容由来) でチャンネル名が
 * 変わり得るが、 このコマンドで固定すると以後は自動リネームを受け付けず、 ユーザ指定名
 * (= 状態絵文字 + エージェント絵文字 + <name>) で進行する。 状態絵文字 (作業中⚙️ / 🟢 /
 * lost / ended) は引き続き反映される。
 */
const chNameCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("ch_name")
    .setDescription("このチャンネル名を固定する (以後 処理内容で自動リネームしない)")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("固定するチャンネル名 (本体スラグ)")
        .setRequired(true)
        .setMaxLength(90),
    ),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    const name = interaction.options.getString("name", true);
    await interaction.deferReply({ ephemeral: true });

    const r = await onSessionChannelNameLocked(
      { guild: deps.guild, layout: deps.layout, repo: deps.sessionChannelsRepo, log: deps.log },
      { sessionId: session.sessionId, name, agentType: null },
    );
    if (!r.ok) {
      await interaction.editReply({ content: `ch_name failed: ${r.reason ?? "unknown"}` });
      return;
    }
    const note =
      r.reason === "rename_deferred"
        ? `\n(Discord のリネーム制限のため表示反映は遅延しますが、 名前固定は有効です)`
        : "";
    await interaction.editReply({
      content: `チャンネル名を **#${r.name}** に固定しました。以後 処理内容では自動リネームしません。${note}`,
    });
  },
};

export default chNameCommand;
