/**
 * プライベート相談のチャンネル操作 (spec/feature/tech-consultation.md §4)。
 *
 * - 「プライベート相談」カテゴリ (無ければ作る) に、 **作成要求の時点で閉じた** テキストチャンネルを作る
 *   (CC-CONSULT-INV-01)。 作ってから閉じると、 その隙間だけ誰でも見られる瞬間ができる。
 * - 閲覧者 (本人・権限者・招待者) の追加・除外は member overwrite で行う。
 * - 終了時は書き込みだけ止めて閲覧は残す。 archive カテゴリへは移さない — 移動でカテゴリの権限に
 *   同期すると閉じた overwrite が外れる。
 * - チャンネル名は内容を含めない (`相談-<日付>-<短い id>`)。
 *
 * @implements SPEC-CONSULT-PRIVATE
 * @implements SPEC-CONSULT-MEMBERS
 * @implements SPEC-CONSULT-CLOSE
 */

import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type Guild,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";

export const PRIVATE_CONSULT_CATEGORY_NAME = "プライベート相談";
export const PRIVATE_CONSULT_CATEGORY_KEY = "private_consult_category_id";

/** 閲覧者に許す操作。 相談なので読み書きと添付まで。 */
const VIEWER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

/**
 * Bot に許す操作 (チームの「管理」チャンネルと同じ集合 + 添付)。 webhook・overwrite の管理は Bot の
 * guild ロールの権限で行う — 自分の持たない権限を overwrite で許そうとすると作成そのものが拒否される。
 */
const BOT_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
];

export interface ConsultCategoryStore {
  categoryId(): string | null;
  setCategoryId(id: string): void;
}

export function privateConsultChannelName(now: Date, consultationId: string): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = consultationId.replace(/^pc_/, "").slice(0, 6);
  return `相談-${date}-${suffix}`;
}

/** 作成時に渡す overwrite。 @everyone を閉じ、 閲覧者と Bot だけを開ける。 */
export function privateConsultOverwrites(guild: Guild, viewerIds: readonly string[]): OverwriteResolvable[] {
  const botId = botUserId(guild);
  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  ];
  for (const id of new Set(viewerIds)) {
    if (id === botId) continue;
    overwrites.push({ id, type: OverwriteType.Member, allow: VIEWER_ALLOW });
  }
  overwrites.push({ id: botId, type: OverwriteType.Member, allow: BOT_ALLOW });
  return overwrites;
}

/** カテゴリを用意する。 カテゴリ自体も @everyone から閉じておく (チャンネル側の overwrite が本線)。 */
export async function ensurePrivateConsultCategory(guild: Guild, store: ConsultCategoryStore): Promise<string> {
  const stored = store.categoryId();
  if (stored) {
    const existing = await guild.channels.fetch(stored).catch(() => null);
    if (existing?.type === ChannelType.GuildCategory) return existing.id;
  }
  const sameName = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && channel.name === PRIVATE_CONSULT_CATEGORY_NAME);
  const category = sameName ?? await guild.channels.create({
    name: PRIVATE_CONSULT_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: botUserId(guild), type: OverwriteType.Member, allow: BOT_ALLOW },
    ],
  });
  store.setCategoryId(category.id);
  return category.id;
}

export async function createPrivateConsultChannel(guild: Guild, input: {
  categoryId: string;
  name: string;
  viewerIds: readonly string[];
}): Promise<TextChannel> {
  return guild.channels.create({
    name: input.name,
    type: ChannelType.GuildText,
    parent: input.categoryId,
    // 作成要求に含める = 最初から閉じている (CC-CONSULT-INV-01)。 lockPermissions はカテゴリへ同期しない。
    permissionOverwrites: privateConsultOverwrites(guild, input.viewerIds),
    reason: "private consultation",
  });
}

export async function grantPrivateConsultViewer(channel: TextChannel, userId: string): Promise<void> {
  await channel.permissionOverwrites.edit(userId, allowMap(VIEWER_ALLOW), {
    type: OverwriteType.Member,
    reason: "private consultation invite",
  });
}

export async function revokePrivateConsultViewer(channel: TextChannel, userId: string): Promise<void> {
  await channel.permissionOverwrites.delete(userId, "private consultation remove");
}

/** 終了時: 閲覧は残し、 Bot 以外の書き込みを止める。 */
export async function lockPrivateConsultChannel(channel: TextChannel): Promise<void> {
  const botId = botUserId(channel.guild);
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== OverwriteType.Member || overwrite.id === botId) continue;
    await channel.permissionOverwrites.edit(overwrite.id, { SendMessages: false, AttachFiles: false }, {
      type: OverwriteType.Member,
      reason: "private consultation closed",
    });
  }
}

function allowMap(flags: readonly bigint[]): Record<string, boolean> {
  const names = Object.entries(PermissionFlagsBits);
  return Object.fromEntries(flags.map((flag) => [names.find(([, value]) => value === flag)![0], true]));
}

function botUserId(guild: Guild): string {
  const botId = guild.client.user?.id;
  if (!botId) throw new Error("Discord bot user is unavailable for private consultation channels");
  return botId;
}
