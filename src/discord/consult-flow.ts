/**
 * プライベート相談の受付の流れ (spec/feature/tech-consultation.md §4)。
 *
 * モーダル送信 → 部署と閲覧者の確定 (service) → 閉じたチャンネルの作成 → 本人に起動権限があれば起動、
 * 無ければチャンネル内に承認ボタン。 承認ボタン → 承認 (service) → 起動。
 * 招待 / 除外 → 権限の判定 (service) → overwrite の付け外し。
 *
 * 応答は本人にだけ返す (ephemeral)。 相談の中身はチャンネルの外へ出さない (CC-CONSULT-INV-03)。
 *
 * @implements SPEC-CONSULT-PRIVATE
 * @implements SPEC-CONSULT-MEMBERS
 */

import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  ModalSubmitInteraction,
  TextChannel,
} from "discord.js";
import { ChannelType } from "discord.js";
import type { PrivateConsultationRow } from "../db/private-consultations-repo.js";
import type {
  PrivateConsultationError,
  PrivateConsultationService,
  PrivateConsultationStore,
} from "../consultation/private-consultation-service.js";
import type { ConsultIntake } from "../dialogue/intake.js";
import {
  createPrivateConsultChannel,
  ensurePrivateConsultCategory,
  grantPrivateConsultViewer,
  privateConsultChannelName,
  revokePrivateConsultViewer,
  type ConsultCategoryStore,
} from "./consult-channel.js";
import { buildConsultApprovalRow, parseConsultApproval, readConsultModal } from "./consult-modal.js";

export interface ConsultSpawnInput {
  consultation: PrivateConsultationRow;
  intake: ConsultIntake;
  guildId: string;
  channelId: string;
  requesterDisplayName: string | null;
}

export interface ConsultFlowDeps {
  service: PrivateConsultationService;
  store: Pick<PrivateConsultationStore, "find" | "findByChannel" | "setChannel">;
  /** この Bot (論理 runtime) の会社。 本社なら null。 */
  runtimeSubsidiaryId: string | null;
  categoryStore: ConsultCategoryStore;
  /** 部署のセッションを起動する (admin spawn)。 */
  spawn(input: ConsultSpawnInput): Promise<{ ok: true } | { ok: false; error: string }>;
  now?: () => Date;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

const ERROR_MESSAGES: Readonly<Record<PrivateConsultationError, string>> = {
  department_not_found: "部署が見つかりません。",
  department_archived: "この部署は廃止されています。",
  department_not_private: "この部署はプライベート相談を受け付けていません。",
  head_office_only: "プライベート相談は本社の部署だけで受け付けています。",
  department_settings_invalid: "部署の設定を読めないため受け付けられません。運用担当に確認してください。",
  intake_incomplete: "知りたいこと・技術レベル・役職を入力してください。",
  consultation_not_found: "このチャンネルはプライベート相談のチャンネルではありません。",
  consultation_closed: "この相談は終了しています。",
  not_pending_approval: "この相談は承認待ちではありません。",
  not_allowed: "この操作は相談者本人か権限者だけが行えます。",
  cannot_remove_requester: "相談者本人は外せません。",
};

export function consultErrorMessage(error: PrivateConsultationError): string {
  return ERROR_MESSAGES[error];
}

export async function handleConsultModalSubmit(interaction: ModalSubmitInteraction, deps: ConsultFlowDeps): Promise<void> {
  const submitted = readConsultModal(interaction);
  const guild = interaction.guild;
  if (!submitted || !guild) {
    await interaction.reply({ content: "この送信を受け付けられませんでした。", ephemeral: true });
    return;
  }
  const started = deps.service.start({
    departmentId: submitted.departmentId,
    runtimeSubsidiaryId: deps.runtimeSubsidiaryId,
    requesterUserId: interaction.user.id,
    intake: submitted.intake,
  });
  if (!started.ok) {
    await interaction.reply({ content: consultErrorMessage(started.error), ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const { consultation, members, needsApproval } = started;
  let channel: TextChannel;
  try {
    const categoryId = await ensurePrivateConsultCategory(guild, deps.categoryStore);
    channel = await createPrivateConsultChannel(guild, {
      categoryId,
      name: privateConsultChannelName(deps.now?.() ?? new Date(), consultation.id),
      viewerIds: members.map((member) => member.platform_user_id),
    });
  } catch (error) {
    // チャンネルが無い相談は続けられない。 閉じて、 本人にだけ理由を返す。
    deps.service.close(consultation.id);
    deps.log.warn(`consult channel create failed consultation=${consultation.id}: ${(error as Error).message}`);
    await interaction.editReply({ content: "相談用のチャンネルを作れませんでした。Bot の権限を運用担当に確認してもらってください。" });
    return;
  }
  deps.store.setChannel(consultation.id, channel.id);
  const viewers = members.map((member) => `<@${member.platform_user_id}>`).join(" ");
  await channel.send({
    content: [
      `<@${consultation.requester_user_id}> のプライベート相談です。`,
      `このチャンネルを見られるのは ${viewers} と Bot だけです。`,
      "`/consult invite` / `/consult remove` で閲覧者を足し引きできます (相談者本人と権限者のみ)。",
      needsApproval ? "起動には起動権限を持つ権限者の承認が要ります。" : "",
    ].filter(Boolean).join("\n"),
    ...(needsApproval ? { components: [buildConsultApprovalRow(consultation.id)] } : {}),
    // 閲覧者への通知は出す (相談が来たことを知らせる)。 閲覧者以外はそもそも見えない。
    allowedMentions: { users: members.map((member) => member.platform_user_id) },
  });
  if (!needsApproval) {
    const launched = await launch(deps, consultation.id, guild, channel.id, interaction.user.displayName ?? null);
    if (!launched.ok) {
      await interaction.editReply({ content: `<#${channel.id}> を作りましたが、セッションの起動に失敗しました: ${launched.error}` });
      return;
    }
  }
  await interaction.editReply({
    content: needsApproval
      ? `<#${channel.id}> を作りました。権限者の承認後にセッションが始まります。`
      : `<#${channel.id}> を作り、セッションを起動しました。`,
  });
}

export async function handleConsultApproval(interaction: ButtonInteraction, deps: ConsultFlowDeps): Promise<void> {
  const consultationId = parseConsultApproval(interaction.customId);
  const guild = interaction.guild;
  if (!consultationId || !guild) {
    await interaction.reply({ content: "この承認を受け付けられませんでした。", ephemeral: true });
    return;
  }
  const approved = deps.service.approve(consultationId, interaction.user.id);
  if (!approved.ok) {
    await interaction.reply({ content: consultErrorMessage(approved.error), ephemeral: true });
    return;
  }
  const channelId = approved.consultation.channel_id;
  if (!channelId) {
    await interaction.reply({ content: "相談のチャンネルが見つかりません。", ephemeral: true });
    return;
  }
  await interaction.update({ components: [] });
  const launched = await launch(deps, consultationId, guild, channelId, null);
  await interaction.followUp({
    content: launched.ok ? `<@${interaction.user.id}> が承認し、セッションを起動しました。` : `セッションの起動に失敗しました: ${launched.error}`,
    allowedMentions: { parse: [] },
  });
}

export async function handleConsultMembership(
  interaction: ChatInputCommandInteraction,
  deps: ConsultFlowDeps,
  action: "invite" | "remove",
): Promise<void> {
  const consultation = interaction.channelId ? deps.store.findByChannel(interaction.channelId) : null;
  const target = interaction.options.getUser("user", true);
  if (!consultation) {
    await interaction.reply({ content: consultErrorMessage("consultation_not_found"), ephemeral: true });
    return;
  }
  if (target.bot) {
    await interaction.reply({ content: "Bot は閲覧者として足し引きできません。", ephemeral: true });
    return;
  }
  const result = action === "invite"
    ? deps.service.invite(consultation.id, interaction.user.id, target.id)
    : deps.service.remove(consultation.id, interaction.user.id, target.id);
  if (!result.ok) {
    await interaction.reply({ content: consultErrorMessage(result.error), ephemeral: true });
    return;
  }
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "チャンネルの権限を変えられませんでした。", ephemeral: true });
    return;
  }
  try {
    if (action === "invite") await grantPrivateConsultViewer(channel, target.id);
    else await revokePrivateConsultViewer(channel, target.id);
  } catch (error) {
    deps.log.warn(`consult ${action} overwrite failed consultation=${consultation.id}: ${(error as Error).message}`);
    await interaction.reply({ content: "チャンネルの権限を変えられませんでした。Bot の権限を確認してください。", ephemeral: true });
    return;
  }
  await interaction.reply({
    content: action === "invite" ? `<@${target.id}> を閲覧者に加えました。` : `<@${target.id}> を閲覧者から外しました。`,
    allowedMentions: { users: action === "invite" ? [target.id] : [] },
  });
}

async function launch(
  deps: ConsultFlowDeps,
  consultationId: string,
  guild: Guild,
  channelId: string,
  requesterDisplayName: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const consultation = deps.store.find(consultationId);
  if (!consultation) return { ok: false, error: "consultation_not_found" };
  try {
    return await deps.spawn({
      consultation,
      intake: deps.service.intakeOf(consultation),
      guildId: guild.id,
      channelId,
      requesterDisplayName,
    });
  } catch (error) {
    deps.log.warn(`consult spawn failed consultation=${consultationId}: ${(error as Error).message}`);
    return { ok: false, error: "spawn_failed" };
  }
}
