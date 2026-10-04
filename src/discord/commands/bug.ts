// @implements SPEC-BOUNTY-INTAKE
// @implements SPEC-BOUNTY-REPORTER
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { handleBountyName, handleBountyWithdraw, type BountyFlowDeps } from "../bounty-flow.js";
import { buildBountyModal } from "../bounty-modal.js";

/**
 * /bug — バグバウンティの報告 (spec/feature/bug-bounty.md §3 §4)。
 *
 * - `report [project:<コード>]`: 報告のモーダルを開く。 送信で受け付ける (bounty-flow.ts)。
 * - `name [name:<公開名>]`: 公開面に出す名前を変える (本人だけ。 空なら匿名へ戻す)。
 * - `withdraw id:<報告 id>`: 採用前の報告を本人が取り下げる。
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
      .addStringOption((o) => o.setName("id").setDescription("報告 id").setRequired(true))),
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
