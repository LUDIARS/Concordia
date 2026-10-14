// @implements SPEC-BOUNTY-INTAKE
// @implements SPEC-BOUNTY-REPORTER
// @implements SPEC-BOUNTY-APPEAL
// @implements SPEC-BOUNTY-CLOSE
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { handleBountyName, handleBountyWithdraw, type BountyFlowDeps } from "../bounty-flow.js";
import { handleBountyAmendOpen, handleBountyAppeal, handleBountyClose } from "../bounty-followup.js";
import { buildBountyModal } from "../bounty-modal.js";

/**
 * /bug — バグバウンティの報告 (spec/feature/bug-bounty.md §3 §4)。
 *
 * - `report [project:<コード>]`: 報告のモーダルを開く。 送信で受け付ける (bounty-flow.ts)。
 * - `name [name:<公開名>]`: 公開面に出す名前を変える (本人だけ。 空なら匿名へ戻す)。
 * - `withdraw id:<報告 id>`: 採用前の報告を本人が取り下げる。
 * - `amend id:<報告 id>`: 情報不足と判定された報告へ本人がモーダルで書き足す。
 * - `appeal id:<報告 id> reason:<理由>`: 判定に 1 回だけ再審を求める (権限者が決める)。
 * - `close id:<報告 id> evidence:<根拠>`: 権限者 (本社の管理職以上) が根拠付きで手動クローズする。
 *
 * 本社 guild と子会社 guild の両方に出す。 応答はどれも本人にだけ返す。
 */
export type BountyCommandDeps = BountyFlowDeps;

/** Discord の autocomplete は 25 件まで。 */
const MAX_CHOICES = 25;
/** Discord の選択肢の表示名は 100 文字まで。 */
const MAX_CHOICE_NAME = 100;

const bugCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("bug")
    .setDescription("仕組みの不具合を報告する (バグバウンティ)")
    .addSubcommand((sub) => sub
      .setName("report")
      .setDescription("不具合を報告する (入力フォームを開く)")
      .addStringOption((o) => o.setName("project").setDescription("対象プロジェクト (分からなければ省略)").setAutocomplete(true)))
    .addSubcommand((sub) => sub
      .setName("name")
      .setDescription("公開面に出す自分の名前を変える (省略すると匿名に戻す)")
      .addStringOption((o) => o.setName("name").setDescription("公開名 (32 文字まで)").setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName("withdraw")
      .setDescription("仕分け前の自分の報告を取り下げる")
      .addStringOption((o) => o.setName("id").setDescription("報告 id").setRequired(true)))
    .addSubcommand((sub) => sub
      .setName("amend")
      .setDescription("情報不足と判定された自分の報告へ書き足す (入力フォームを開く)")
      .addStringOption((o) => o.setName("id").setDescription("報告 id").setRequired(true)))
    .addSubcommand((sub) => sub
      .setName("appeal")
      .setDescription("自分の報告の判定に再審を求める (1 報告 1 回)")
      .addStringOption((o) => o.setName("id").setDescription("報告 id").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("再審を求める理由").setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub
      .setName("close")
      .setDescription("[権限者] 反映を確認した報告を根拠付きで閉じる")
      .addStringOption((o) => o.setName("id").setDescription("報告 id").setRequired(true))
      .addStringOption((o) => o.setName("evidence").setDescription("閉じる根拠 (反映を確認した事実)").setRequired(true).setMaxLength(1000))),
  async execute(interaction, deps) {
    const bounty = deps.bounty;
    if (!bounty) {
      await interaction.reply({ content: "バグ報告はこの Bot で使えません。", ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "name") {
      await handleBountyName(interaction, bounty);
      return;
    }
    if (sub === "withdraw") {
      await handleBountyWithdraw(interaction, bounty);
      return;
    }
    if (sub === "amend") {
      await handleBountyAmendOpen(interaction);
      return;
    }
    if (sub === "appeal") {
      await handleBountyAppeal(interaction, bounty);
      return;
    }
    if (sub === "close") {
      await handleBountyClose(interaction, bounty);
      return;
    }
    // モーダルは最初の応答でしか出せない (defer しない)。
    await interaction.showModal(buildBountyModal({
      project: interaction.options.getString("project"),
      publicName: bounty.currentPublicName(interaction.user.id),
    }));
  },
  async autocomplete(interaction, deps) {
    const query = interaction.options.getFocused().toString().trim().toLowerCase();
    const projects = deps.bounty?.projects() ?? [];
    await interaction.respond(projects
      .filter((project) => !query
        || project.code.toLowerCase().includes(query)
        || project.project.toLowerCase().includes(query))
      .slice(0, MAX_CHOICES)
      .map((project) => ({ name: `${project.code} — ${project.project}`.slice(0, MAX_CHOICE_NAME), value: project.code })));
  },
};

export default bugCommand;
