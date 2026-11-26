/**
 * /glab-unity-token — GLab-UnityHub に繋ぐためのトークンを、 打った本人の分だけ発行・一覧・失効する
 * (spec/feature/glab-unity-hub.md §1、 契約 v1 §1)。
 *
 * - サブコマンド `issue [label]` / `list` / `revoke <prefix>`。 対象ユーザーの引数は持たない
 *   (他人宛て・代理発行は作れない。 管理者でも同じ)。
 * - GLab の Discord サーバー (guild id は設定値) からだけ受ける。 DM や他サーバーは断る。
 * - 返信はすべて ephemeral。 平文トークンは発行時の 1 回だけ表示する (DB はハッシュだけ)。
 * - 失効すると、 接続中の Unity も Hub が数秒以内に切断する。
 *
 * @implements spec/feature/glab-unity-hub.md §1 (GUH-TOKEN)
 */

import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { createGlabUnityTokenService } from "../../glab-unity-hub/adapters/module-store.js";
import type { GlabUnityTokenCommandPort } from "../../glab-unity-hub/application/token-service.js";
import { MAX_ACTIVE_TOKENS_PER_USER, MAX_LABEL_LENGTH } from "../../glab-unity-hub/domain/token-policy.js";

export const GLAB_UNITY_TOKEN_COMMAND = "glab-unity-token";

export type { GlabUnityTokenCommandPort };

let cachedDefault: GlabUnityTokenCommandPort | null | undefined;

/** deps に注入が無ければ、 設定からモジュール DB を開いて使う (1 プロセス 1 回)。 */
function defaultPort(): GlabUnityTokenCommandPort | null {
  if (cachedDefault === undefined) cachedDefault = createGlabUnityTokenService();
  return cachedDefault;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function issueReply(result: ReturnType<GlabUnityTokenCommandPort["issue"]>): string {
  if (!result.ok) {
    return result.reason === "limit_reached"
      ? `有効なトークンは 1 人 ${MAX_ACTIVE_TOKENS_PER_USER} 本までです。 \`/glab-unity-token list\` で確認し、 不要なものを \`revoke\` してください。`
      : "このコマンドは GLab の Discord サーバーでだけ使えます。";
  }
  return [
    "🔑 GLab-UnityHub のトークンを発行しました (あなた専用)。",
    "```",
    result.token,
    "```",
    "- **この表示は 1 回だけです。** Unity の `Foundation/GLab Hub` → セットアップに貼り付けてください。",
    "- 他人に渡さないでください。 漏れたら `/glab-unity-token revoke " + result.displayPrefix + "` で失効できます。",
    `- 識別子: \`${result.displayPrefix}\` / ラベル: ${result.label ?? "なし"} / 期限: ${formatDate(result.expiresAt)}`,
  ].join("\n");
}

export function listReply(result: ReturnType<GlabUnityTokenCommandPort["list"]>): string {
  if (!Array.isArray(result)) return "このコマンドは GLab の Discord サーバーでだけ使えます。";
  if (result.length === 0) return "有効なトークンはありません。 `/glab-unity-token issue` で発行できます。";
  const lines = result.map((token) =>
    `- \`${token.displayPrefix}…\` ${token.label ?? "(ラベルなし)"} / 発行 ${formatDate(token.createdAt)} / 期限 ${formatDate(token.expiresAt)}`
    + ` / 最終利用 ${token.lastUsedAt ? formatDate(token.lastUsedAt) : "なし"}`);
  return ["あなたの有効なトークン:", ...lines].join("\n");
}

export function revokeReply(result: ReturnType<GlabUnityTokenCommandPort["revoke"]>): string {
  if (result.ok) return `トークン \`${result.displayPrefix}…\` を失効しました。 接続中の Unity は数秒以内に切断されます。`;
  switch (result.reason) {
    case "wrong_guild": return "このコマンドは GLab の Discord サーバーでだけ使えます。";
    case "prefix_too_short": return "識別子が短すぎます。 `/glab-unity-token list` に出る `glu_…` の識別子を指定してください。";
    case "ambiguous": return "複数のトークンに当てはまります。 もう少し長く指定してください。";
    default: return "あなたの有効なトークンの中に、 その識別子のものはありません。";
  }
}

const glabUnityTokenCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName(GLAB_UNITY_TOKEN_COMMAND)
    .setDescription("GLab-UnityHub (Unity 連携) のトークンを自分の分だけ発行・確認・失効する")
    .addSubcommand((sub) => sub.setName("issue").setDescription("自分用のトークンを発行する (表示は 1 回だけ)")
      .addStringOption((o) => o.setName("label").setDescription("用途のメモ (例: 自宅PC)").setRequired(false).setMaxLength(MAX_LABEL_LENGTH)))
    .addSubcommand((sub) => sub.setName("list").setDescription("自分の有効なトークンを確認する"))
    .addSubcommand((sub) => sub.setName("revoke").setDescription("自分のトークンを失効する")
      .addStringOption((o) => o.setName("prefix").setDescription("list に出る識別子 (glu_…)").setRequired(true).setMaxLength(64))),
  async execute(interaction, deps) {
    const port = deps.glabUnityTokens !== undefined ? deps.glabUnityTokens : defaultPort();
    if (!port) {
      await interaction.reply({ content: "GLab-UnityHub が設定されていません (GLab の guild id が未設定)。", ephemeral: true });
      return;
    }
    // 発行対象は常にコマンドを打った本人。 guild は interaction のものだけを信じる (DM は null)。
    const actor = { discordUserId: interaction.user.id, guildId: interaction.guildId ?? null };
    const sub = interaction.options.getSubcommand(true);
    let content: string;
    if (sub === "issue") content = issueReply(port.issue(actor, interaction.options.getString("label")));
    else if (sub === "list") content = listReply(port.list(actor));
    else if (sub === "revoke") content = revokeReply(port.revoke(actor, interaction.options.getString("prefix", true)));
    else content = "不明なサブコマンドです。";
    await interaction.reply({ content, ephemeral: true });
  },
};

export default glabUnityTokenCommand;
