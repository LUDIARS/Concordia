// @implements CC-ACTIO-CHAT-COMMAND-01
import type { Interaction } from "discord.js";

export const backlogCommands = [
  { name: "backlog", description: "バックログを追加", type: 1, options: [{ name: "add", description: "本文または元投稿を受付", type: 1, options: [
    { name: "text", description: "追加する内容", type: 3, max_length: 3500 },
    { name: "message", description: "同じ受付チャンネルのメッセージリンク", type: 3 },
  ] }] }, { name: "バックログに追加", type: 3 },
];
/** @implements CC-ACTIO-CHAT-COMMAND-01 */
export function backlogInput(text: string | null, link: string | null, guild: string, channel: string): { text: string } | { error: string } {
  text = text?.trim() || null; link = link?.trim() || null;
  if (!!text === !!link) return { error: "本文かメッセージリンクをどちらか1つ指定してください。" };
  if (link) {
    const match = link.match(/^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/u);
    if (!match || match[1] !== guild || match[2] !== channel) return { error: "同じ受付チャンネルのメッセージリンクを指定してください。" };
  }
  const content = text ?? link ?? "";
  return content.length > 3500 ? { error: "本文は3500文字以内で指定してください。" } : { text: content };
}
/** @implements CC-ACTIO-CHAT-COMMAND-01 */
export async function handleBacklogCommand(interaction: Interaction, admission?: (guild: string, channel: string) => Promise<boolean>): Promise<boolean> {
  if (!("commandName" in interaction) || !["backlog", "バックログに追加"].includes(interaction.commandName)) return false;
  if (!(interaction.isChatInputCommand() && interaction.commandName === "backlog")
    && !(interaction.isMessageContextMenuCommand() && interaction.commandName === "バックログに追加")) return false;
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.guildId || !interaction.channelId || !admission) {
    await interaction.editReply("バックログ受付が設定されていません。"); return true;
  }
  let allowed: boolean;
  try { allowed = await admission(interaction.guildId, interaction.channelId); }
  catch { await interaction.editReply("Actioの受付を確認できません。投稿は行っていません。接続状態を確認してください。"); return true; }
  if (!allowed) { await interaction.editReply("有効なバックログ受付チャンネルで実行してください。"); return true; }
  if (interaction.isChatInputCommand() && interaction.options.getSubcommand() !== "add") {
    await interaction.editReply("対応していないコマンドです。"); return true;
  }
  const input = interaction.isMessageContextMenuCommand()
    ? backlogInput(null, `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${interaction.targetId}`, interaction.guildId, interaction.channelId)
    : backlogInput(interaction.options.getString("text"), interaction.options.getString("message"), interaction.guildId, interaction.channelId);
  if ("error" in input) { await interaction.editReply(input.error); return true; }
  // Exactly one public follow-up. Unknown delivery is never blindly retried.
  try {
    const sent = await interaction.followUp({ content: "バックログの追加を受け付けました。内容確認用のスレッドに不足事項を投稿します（タスク確定前）。",
      ephemeral: false, allowedMentions: { parse: [] }, embeds: [{ description: input.text, footer: { text: "actio-backlog-command:v1" } }] });
    await interaction.editReply(`受付メッセージ: ${sent.url}`);
  } catch {
    await interaction.editReply("投稿結果を確認できません。二重投稿を避けるため、受付チャンネルを確認してから操作してください。");
  }
  return true;
}
