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
import { privateConsultChannelName } from "./consult-channel.js";
import {
  createPrivateChannel,
  ensurePrivateCategory,
  grantPrivateViewer,
  revokePrivateViewer,
  type PrivateCategoryStore,
} from "./private-channel-discord.js";
import { buildConsultApprovalRow, parseConsultApproval, readConsultModal } from "./consult-modal.js";
import type { PublicationInteractionDeps } from "./consult-publication.js";

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
  categoryStore: PrivateCategoryStore;
  /**
   * この guild に居る閲覧者候補。 未指定なら絞らない。 社員名簿は会社の所属を持たないので、 名簿の権限者を
   * その guild の在籍者に絞る (staff-roster.md §9)。 居ない人へ member overwrite を付けるとチャンネル作成ごと失敗し、
   * メンションも届かない。
   */
  viewerCandidates?(guild: Guild): Promise<readonly string[]>;
  /** 部署のセッションを起動する (admin spawn)。 */
  spawn(input: ConsultSpawnInput): Promise<{ ok: true } | { ok: false; error: string }>;
  now?: () => Date;
  log: { info: (message: string) => void; warn: (message: string) => void };
  /** `/consult wrap`: セッションへ公開候補づくりを依頼する (tech-consultation.md §5)。 */
  requestProposal?(input: { sessionId: string; actorUserId: string; actorLabel: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 公開候補カードの判断 (Cc の API 経由)。 */
  publication?: PublicationInteractionDeps;
}

const ERROR_MESSAGES: Readonly<Record<PrivateConsultationError, string>> = {
  department_not_found: "部署が見つかりません。",
  department_archived: "この部署は廃止されています。",
  department_not_private: "この部署はプライベート相談を受け付けていません。",
  department_other_organization: "この部署はこのサーバでは受け付けていません。",
  subsidiary_requires_projectless: "この部署はこのサーバでプライベート相談を受け付けていません。",
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
  let viewerCandidates: readonly string[] | undefined;
  if (deps.viewerCandidates) {
    try {
      viewerCandidates = await deps.viewerCandidates(guild);
    } catch (error) {
      // 在籍を確かめられないまま広く足すと作成ごと失敗しうる。 権限者なしで続けず、 本人に理由を返す。
      deps.log.warn(`consult viewer lookup failed guild=${guild.id}: ${(error as Error).message}`);
      await interaction.reply({ content: "権限者を確認できなかったため受け付けられませんでした。時間をおいてもう一度お試しください。", ephemeral: true });
      return;
    }
  }
  const started = deps.service.start({
    departmentId: submitted.departmentId,
    runtimeSubsidiaryId: deps.runtimeSubsidiaryId,
    requesterUserId: interaction.user.id,
    intake: submitted.intake,
    ...(viewerCandidates ? { viewerCandidates } : {}),
  });
  if (!started.ok) {
    await interaction.reply({ content: consultErrorMessage(started.error), ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const { consultation, members, needsApproval } = started;
  let channel: TextChannel;
  try {
    const categoryId = await ensurePrivateCategory(guild, deps.categoryStore);
    channel = await createPrivateChannel(guild, {
      reason: "private consultation",
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
  await channel.send({
    content: [
      `<@${consultation.requester_user_id}> のプライベート相談です。`,
      "このチャンネルは相談者本人と執行役員だけが見られます。",
      "`/consult invite` / `/consult remove` で閲覧者を足し引きできます (相談者本人と権限者のみ)。",
      needsApproval ? "起動には起動権限を持つ権限者の承認が要ります。" : "",
    ].filter(Boolean).join("\n"),
    ...(needsApproval ? { components: [buildConsultApprovalRow(consultation.id)] } : {}),
    // 権限者 (執行役員) は表示も通知もしない (2026-10-02 neco 指示)。 通知するのは相談者本人だけ。
    allowedMentions: { users: [consultation.requester_user_id] },
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
    if (action === "invite") await grantPrivateViewer(channel, target.id, "private consultation invite");
    else await revokePrivateViewer(channel, target.id, "private consultation remove");
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

/**
 * `/consult wrap`: 相談の区切りで、 セッションに公開候補づくりを依頼する。 相談者本人か権限者だけ。
 * 候補の文面はセッションが作り API へ出す。 公開の判断はチャンネルのカードで本人が行う。
 */
export async function handleConsultWrap(interaction: ChatInputCommandInteraction, deps: ConsultFlowDeps): Promise<void> {
  const consultation = interaction.channelId ? deps.store.findByChannel(interaction.channelId) : null;
  if (!consultation) {
    await interaction.reply({ content: consultErrorMessage("consultation_not_found"), ephemeral: true });
    return;
  }
  if (consultation.status !== "open" || !consultation.session_id) {
    await interaction.reply({ content: "この相談のセッションは動いていないため、公開候補を作れません。", ephemeral: true });
    return;
  }
  const actor = deps.service.memberOf(consultation.id, interaction.user.id);
  if (!actor || (actor.reason !== "requester" && actor.reason !== "approver")) {
    await interaction.reply({ content: consultErrorMessage("not_allowed"), ephemeral: true });
    return;
  }
  if (!deps.requestProposal) {
    await interaction.reply({ content: "公開候補の依頼はこの Bot で使えません。", ephemeral: true });
    return;
  }
  const requested = await deps.requestProposal({
    sessionId: consultation.session_id,
    actorUserId: interaction.user.id,
    actorLabel: interaction.user.displayName ?? interaction.user.id,
  });
  await interaction.reply({
    content: requested.ok
      ? "セッションに公開候補づくりを依頼しました。候補が届いたら、このチャンネルに判断カードが出ます。"
      : `依頼に失敗しました: ${requested.error}`,
    ephemeral: true,
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
