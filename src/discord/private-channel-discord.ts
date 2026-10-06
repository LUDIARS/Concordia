/**
 * 閉じた Discord チャンネルの作成と閲覧者の付け外し (spec/feature/private-channels.md §1)。
 *
 * プライベート相談 (consult-*) と報告用のプライベートチャンネル (private-channel-provisioner) が共有する
 * 唯一の作成経路。
 * - 「プライベート」カテゴリ (無ければ作る) に、 **作成要求の時点で閉じた** テキストチャンネルを作る
 *   (CC-PRIVCH-INV-01)。 作ってから閉じると、 その隙間だけ誰でも見られる瞬間ができる。
 * - 閲覧者の追加・除外は member overwrite で行う。 終了時は書き込みだけ止めて閲覧は残す。
 * - 旧名「プライベート相談」のカテゴリを保存していれば、 それを引き継いで名前を揃える。
 *
 * @implements SPEC-PRIVCH-CHANNEL
 */

import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";

export const PRIVATE_CATEGORY_NAME = "プライベート";
export const PRIVATE_CATEGORY_KEY = "private_category_id";
/** 統合前 (プライベート相談だけだった頃) のカテゴリ。 保存済みなら引き継ぐ。 */
export const LEGACY_PRIVATE_CATEGORY_KEY = "private_consult_category_id";
const LEGACY_PRIVATE_CATEGORY_NAMES = ["プライベート相談"];

/** 閲覧者に許す操作。 読み書きと添付まで。 */
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

export interface PrivateCategoryStore {
  /** 保存済みのカテゴリ id (新しいキー → 旧キーの順)。 */
  categoryId(): string | null;
  setCategoryId(id: string): void;
}

/** 作成時に渡す overwrite。 @everyone を閉じ、 閲覧者と Bot だけを開ける。 */
export function privateChannelOverwrites(guild: Guild, viewerIds: readonly string[]): OverwriteResolvable[] {
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
export async function ensurePrivateCategory(guild: Guild, store: PrivateCategoryStore): Promise<string> {
  const stored = store.categoryId();
  if (stored) {
    const existing = await guild.channels.fetch(stored).catch(() => null);
    if (existing?.type === ChannelType.GuildCategory) {
      await alignCategoryName(existing as CategoryChannel);
      store.setCategoryId(existing.id);
      return existing.id;
    }
  }
  const sameName = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory
    && (channel.name === PRIVATE_CATEGORY_NAME || LEGACY_PRIVATE_CATEGORY_NAMES.includes(channel.name)));
  const category = sameName ?? await guild.channels.create({
    name: PRIVATE_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: botUserId(guild), type: OverwriteType.Member, allow: BOT_ALLOW },
    ],
  });
  if (sameName) await alignCategoryName(sameName as CategoryChannel);
  store.setCategoryId(category.id);
  return category.id;
}

export async function createPrivateChannel(guild: Guild, input: {
  categoryId: string;
  name: string;
  viewerIds: readonly string[];
  reason: string;
}): Promise<TextChannel> {
  return guild.channels.create({
    name: input.name,
    type: ChannelType.GuildText,
    parent: input.categoryId,
    // 作成要求に含める = 最初から閉じている (CC-PRIVCH-INV-01)。 カテゴリの権限には同期しない。
    permissionOverwrites: privateChannelOverwrites(guild, input.viewerIds),
    reason: input.reason,
  });
}

export async function grantPrivateViewer(channel: TextChannel, userId: string, reason = "private channel viewer"): Promise<void> {
  await channel.permissionOverwrites.edit(userId, allowMap(VIEWER_ALLOW), { type: OverwriteType.Member, reason });
}

export async function revokePrivateViewer(channel: TextChannel, userId: string, reason = "private channel viewer removed"): Promise<void> {
  await channel.permissionOverwrites.delete(userId, reason);
}

/** 閲覧者 1 人分の書き込み停止の上限。 超えたらその人を飛ばして次へ進む (速度制限の待ちで全体が止まらないように)。 */
export const LOCK_MEMBER_TIMEOUT_MS = 10_000;

/**
 * 終了時: 閲覧は残し、 Bot 以外の書き込みを止める。
 *
 * 閲覧者ごとに上限付きで行い、 結果と所要時間を記録する。 1 人が止まっても残りは続け、 最後に失敗した人数を
 * 例外で返す (2026-10-06、 相談者以外の閲覧者がいる相談チャンネルで書き込み停止が止まった件の調査)。
 */
export async function lockPrivateChannel(
  channel: TextChannel,
  options: { log?: { info(message: string): void; warn(message: string): void }; memberTimeoutMs?: number } = {},
): Promise<void> {
  const botId = botUserId(channel.guild);
  const timeoutMs = options.memberTimeoutMs ?? LOCK_MEMBER_TIMEOUT_MS;
  const failed: string[] = [];
  for (const overwrite of [...channel.permissionOverwrites.cache.values()]) {
    if (overwrite.type !== OverwriteType.Member || overwrite.id === botId) continue;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        channel.permissionOverwrites.edit(overwrite.id, { SendMessages: false, AttachFiles: false }, {
          type: OverwriteType.Member,
          reason: "private channel closed",
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); }),
      ]);
      options.log?.info(`private channel lock ok channel=${channel.id} member=${overwrite.id} ms=${Date.now() - started}`);
    } catch (error) {
      failed.push(overwrite.id);
      options.log?.warn(`private channel lock failed channel=${channel.id} member=${overwrite.id} ms=${Date.now() - started}: ${(error as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (failed.length > 0) throw new Error(`private channel lock failed for ${failed.length} member(s)`);
}

async function alignCategoryName(category: CategoryChannel): Promise<void> {
  if (category.name === PRIVATE_CATEGORY_NAME) return;
  await category.setName(PRIVATE_CATEGORY_NAME, "private channel category merged").catch(() => {
    // 改名はレート制限に掛かりうる。 名前は表示だけなので次の作成で揃え直す。
  });
}

function allowMap(flags: readonly bigint[]): Record<string, boolean> {
  const names = Object.entries(PermissionFlagsBits);
  return Object.fromEntries(flags.map((flag) => [names.find(([, value]) => value === flag)![0], true]));
}

function botUserId(guild: Guild): string {
  const botId = guild.client.user?.id;
  if (!botId) throw new Error("Discord bot user is unavailable for private channels");
  return botId;
}
