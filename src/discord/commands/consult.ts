// @implements SPEC-CONSULT-PRIVATE
// @implements SPEC-CONSULT-MEMBERS
// @implements SPEC-CONSULT-DRIVE-TRANSFER
import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandSpec } from "../command-port.js";
import { handleConsultMembership, handleConsultWrap } from "../consult-flow.js";
import { buildConsultModal } from "../consult-modal.js";
import { handleConsultFiles, handleConsultFilesSync } from "../consult-drive.js";
import type { ConsultCommandDeps } from "./consult-deps.js";

export type { ConsultCommandDeps } from "./consult-deps.js";

/**
 * /consult — プライベート相談 (spec/feature/tech-consultation.md §4)。
 *
 * - `start department:<部署>`: 事前ヒアリングのモーダルを開く。 送信で閉じたチャンネルを作る (consult-flow.ts)。
 * - `invite user:@x` / `remove user:@x`: 相談チャンネル内で閲覧者を足し引きする (相談者本人と権限者のみ)。
 * - `wrap`: 相談の区切りで、 セッションに公開候補 (書き直した要約) づくりを依頼する (§5)。
 * - `files [folder:<URL か ID>]` / `files-sync`: Google Drive でのファイル受け渡し (§6.4、 consult-drive.ts)。
 *   相談者が自分のフォルダを Cc のサービスアカウントへ編集者で共有し、 その URL を渡して結び付ける。
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
      .setDescription("この相談から全体に共有できる知見の公開候補を作ってもらう (相談者本人と権限者のみ)"))
    .addSubcommand((sub) => sub
      .setName("files")
      .setDescription("3D モデル・音声の受け渡しフォルダ (自分の Google Drive) の共有手順を見る・結び付ける (相談者本人のみ)")
      .addStringOption((o) => o.setName("folder").setDescription("Cc に編集者で共有したフォルダの URL か ID (省略すると共有の手順を表示)").setRequired(false).setMaxLength(500)))
    .addSubcommand((sub) => sub
      .setName("files-sync")
      .setDescription("受け渡しフォルダのファイルを相談へ取り込み、回答のファイルを置く (相談者本人と権限者のみ)")),
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
    if (sub === "files" || sub === "files-sync") {
      if (!consult.drive) {
        await interaction.reply({ content: "ファイル受け渡しはこの Bot で使えません。", ephemeral: true });
        return;
      }
      await (sub === "files" ? handleConsultFiles(interaction, consult.drive) : handleConsultFilesSync(interaction, consult.drive));
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
