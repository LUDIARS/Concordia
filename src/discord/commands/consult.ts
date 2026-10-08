// @implements SPEC-CONSULT-PRIVATE
// @implements SPEC-CONSULT-MEMBERS
import { SlashCommandBuilder } from "discord.js";
import type { ConsultCommandDeps } from "../consult-command-types.js";
export type { ConsultCommandDeps } from "../consult-command-types.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { handleConsultMembership, handleConsultWrap } from "../consult-flow.js";
import { buildConsultModal } from "../consult-modal.js";

/**
 * /consult — プライベート相談 (spec/feature/tech-consultation.md §4)。
 *
 * - `start department:<部署>`: 事前ヒアリングのモーダルを開く。 送信で閉じたチャンネルを作る (consult-flow.ts)。
 * - `invite user:@x` / `remove user:@x`: 相談チャンネル内で閲覧者を足し引きする (相談者本人と権限者のみ)。
 * - `wrap`: 相談の区切りで、 セッションに公開候補 (書き直した要約) づくりを依頼する (§5)。
 *
 * 本社 guild と、 子会社 guild (その会社のプロジェクトを持たない相談部署だけ、 tech-consultation.md §6) に出す。
 * 子会社では wrap (公開候補) を使えない (Bot が requestProposal を配線しない)。
 */

/** Discord の autocomplete は 25 件まで。 */
const MAX_CHOICES = 25;

const consultCommand: DiscordCommandSpec = {
  builder: new SlashCommandBuilder()
    .setName("consult")
    .setDescription("本人と権限者だけが見られるプライベート相談")
    .addSubcommand((sub) => sub
      .setName("start")
      .setDescription("プライベート相談を始める (閉じたチャンネルを作る)")
      .addStringOption((o) => o.setName("department").setDescription("相談先の部署").setRequired(true).setAutocomplete(true)))
    .addSubcommand((sub) => sub
      .setName("invite")
      .setDescription("この相談の閲覧者に加える (相談者本人と権限者のみ)")
      .addUserOption((o) => o.setName("user").setDescription("加える人").setRequired(true)))
    .addSubcommand((sub) => sub
      .setName("remove")
      .setDescription("この相談の閲覧者から外す (相談者本人と権限者のみ)")
      .addUserOption((o) => o.setName("user").setDescription("外す人").setRequired(true)))
    .addSubcommand((sub) => sub
      .setName("wrap")
      .setDescription("この相談から全体に共有できる知見の公開候補を作ってもらう (相談者本人と権限者のみ)")),
  async execute(interaction, deps) {
    const consult = deps.consult;
    if (!consult) {
      await interaction.reply({ content: "プライベート相談はこの Bot で使えません。", ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "wrap") {
      await handleConsultWrap(interaction, consult);
      return;
    }
    if (sub === "invite" || sub === "remove") {
      await handleConsultMembership(interaction, consult, sub);
      return;
    }
    const departmentId = interaction.options.getString("department", true);
    const department = consult.privateDepartments().find((candidate) => candidate.id === departmentId);
    if (!department) {
      await interaction.reply({ content: "プライベート相談を受け付けている部署から選んでください。", ephemeral: true });
      return;
    }
    // モーダルは最初の応答でしか出せない (defer しない)。
    await interaction.showModal(buildConsultModal({
      departmentId: department.id,
      departmentName: department.name,
      defaults: consult.requesterDefaults(interaction.user.id),
    }));
  },
  async autocomplete(interaction, deps) {
    const query = interaction.options.getFocused().toString().trim();
    const departments = deps.consult?.privateDepartments() ?? [];
    await interaction.respond(departments
      .filter((department) => !query || department.name.includes(query))
      .slice(0, MAX_CHOICES)
      .map((department) => ({ name: department.name, value: department.id })));
  },
};

export default consultCommand;
