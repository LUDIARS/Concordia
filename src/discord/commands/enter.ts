import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia, requireSessionChannel } from "./_util.js";
import { ENTER_KEY_TEXT } from "../../control/enter-key.js";

/**
 * /enter — wrapped CLI session に「改行 (Enter キー押下) だけ」 を送る.
 *
 * 「text を渡してそれを inject する」 用途は元々の実装にあったが、 ユーザ運用
 * では「対話 prompt の確定だけ Discord から押したい」 ケースが圧倒的に多く、
 * テキスト引数は混乱の元 (空文字を送れない / 改行を含めにくい) だった。
 * → 引数を撤廃し、 常に Enter キー相当の CR だけを inject する仕様にする。
 *
 * Lictor 側で codex 向けに trailing CR/LF を strip するロジック (PR #16) が
 * あるため、 CR 単体を「Enter キーだけ pty に送る」ものとして扱う。
 */
const enterCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("enter")
    .setDescription("Send an Enter key press to the current session"),
  async execute(interaction, deps) {
    const session = await requireSessionChannel(interaction, deps.sessionChannelsRepo);
    if (!session) return;
    await interaction.deferReply({ ephemeral: true });
    const r = await callConcordia<{ ok: boolean }>(
      deps.concordiaUrl,
      "POST",
      `/v1/sessions/${session.sessionId}/inject`,
      { text: ENTER_KEY_TEXT, source: "discord-enter" },
    );
    if ("error" in r) {
      await interaction.editReply({ content: `enter failed: ${r.error}` });
      return;
    }
    await interaction.editReply({ content: "Enter pressed." });
  },
};

export default enterCommand;
