import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../commands.js";
import { callConcordia } from "./_util.js";

interface ConfirmRunView {
  repo_name: string;
  service_code: string | null;
  pr_number: number;
  pr_title: string;
  status: string;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * develop に入った変更の動作確認。 開始も完了も人間が明示的に打つ (自動判定しない)。
 * spec/feature/develop-confirm-flow.md §6。
 */
const confirmCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("confirm")
    .setDescription("develop に入った変更の動作確認 (起動切替 → main 反映)")
    .addSubcommand((s) => s.setName("list").setDescription("確認待ち / 確認中の一覧"))
    .addSubcommand((s) =>
      s.setName("start").setDescription("develop 版に切り替えて起動する")
        .addStringOption((o) => o.setName("service").setDescription("サービスコード (例 concordia)").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("ok").setDescription("確認 OK → main に反映して main 版で起動し直す")
        .addStringOption((o) => o.setName("service").setDescription("サービスコード").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("ng").setDescription("確認中止 → main 版に戻す")
        .addStringOption((o) => o.setName("service").setDescription("サービスコード").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("戻す理由").setRequired(false)),
    ),

  async execute(interaction, deps) {
    // 起動切替・ビルドは分単位で掛かるので必ず defer する。
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      const r = await callConcordia<{ confirms: ConfirmRunView[] }>(deps.concordiaUrl, "GET", "/v1/confirm");
      if ("error" in r) {
        await interaction.editReply({ content: `確認一覧の取得に失敗: ${r.error}` });
        return;
      }
      await interaction.editReply({ content: renderList(r.confirms) });
      return;
    }

    const service = interaction.options.getString("service", true);
    const reason = interaction.options.getString("reason") ?? undefined;
    const r = await callConcordia<ActionResult>(
      deps.concordiaUrl,
      "POST",
      `/v1/confirm/${sub}`,
      { service, session_id: `discord:${interaction.user.id}`, reason },
    );
    if ("error" in r) {
      await interaction.editReply({ content: `/confirm ${sub} に失敗: ${r.error}` });
      return;
    }
    await interaction.editReply({ content: r.message.slice(0, 1900) });
  },
};

function renderList(confirms: ConfirmRunView[]): string {
  if (confirms.length === 0) return "確認待ちの変更はありません。";
  const lines = confirms.map((c) => {
    const mark = c.status === "confirming" ? "🔎" : "⏳";
    const svc = c.service_code ?? "(起動なし)";
    return `${mark} ${svc} — ${c.repo_name} #${c.pr_number} ${c.pr_title}`;
  });
  return ["**確認待ち / 確認中**", ...lines].join("\n").slice(0, 1900);
}

export default confirmCommand;
