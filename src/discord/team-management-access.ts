import type Database from "better-sqlite3";
import {
  OverwriteType,
  PermissionFlagsBits,
  type Guild,
  type GuildChannel,
} from "discord.js";

/**
 * チームの `管理` 面 (権限者限定チャンネル) の閲覧許可を、社員名簿と一致させる。
 *
 * 面そのものの作成は team-provision.ts が持ち、ここは**誰が見られるか**だけを扱う。
 * 権限計算とチャンネル生成は変わる理由が違う (前者は名簿の更新、後者はチーム構成) ので分ける。
 *
 * @implements spec/tasks/2026-09-04-team-management-surface.md
 */

export interface ManagementAccessSync {
  /** 許可を持つべき Discord ユーザ ID (名簿から算出)。 */
  readonly allowed: string[];
  /** 今回新しく許可した ID。 */
  readonly added: string[];
  /** 名簿から外れたので許可を外した ID。 */
  readonly removed: string[];
}

const ACCESS_SYNC_REASON = "Concordia team management surface access sync";
const channelSyncQueues = new Map<string, Promise<ManagementAccessSync>>();

/** 名簿から `管理` 面を見られる Discord ユーザ ID を引く。 */
export function managementViewerIds(db: Database.Database): string[] {
  const rows = db.prepare(
    `SELECT platform_user_id FROM staff_members WHERE platform = 'discord' AND role IN ('manager', 'executive')`,
  ).all() as { platform_user_id: string }[];
  return [...new Set(rows.map((row) => row.platform_user_id))].sort();
}

/**
 * `管理` 面の overwrite を名簿と一致させる。
 *
 * **昇格した ID を足すだけでなく、降格・名簿削除された ID の古い許可も外す。**
 * 足すだけだと、権限者でなくなった人が見え続ける — 権限者限定の面としては壊れている。
 *
 * bot 自身の許可は名簿と無関係に必ず残す。 カードを投稿できなくなると面が死ぬため。
 */
export function syncManagementAccess(input: {
  guild: Guild;
  // スレッドは overwrite を持たない。 面はカテゴリ直下のチャンネルなので GuildChannel で足りる。
  channel: GuildChannel;
  db: Database.Database;
}): Promise<ManagementAccessSync> {
  // boot / team.changed / staff.access_changed が重なっても、古い名簿 snapshot の同期を
  // 後勝ちさせない。各実行は自分の開始時点で名簿を読み直す。
  const previous = channelSyncQueues.get(input.channel.id);
  const scheduled = (previous?.catch(() => undefined) ?? Promise.resolve())
    .then(() => syncManagementAccessNow(input));
  channelSyncQueues.set(input.channel.id, scheduled);
  return scheduled.finally(() => {
    if (channelSyncQueues.get(input.channel.id) === scheduled) {
      channelSyncQueues.delete(input.channel.id);
    }
  });
}

async function syncManagementAccessNow(input: {
  guild: Guild;
  channel: GuildChannel;
  db: Database.Database;
}): Promise<ManagementAccessSync> {
  const { guild, channel, db } = input;
  const allowed = managementViewerIds(db);
  const botId = managementBotId(guild);

  // 旧版や手動作成の同名チャンネルを採用した場合も、公開状態を残さない。
  await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
    ViewChannel: false,
  }, { reason: ACCESS_SYNC_REASON });

  const existing = new Set<string>();
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type === OverwriteType.Member) {
      existing.add(overwrite.id);
      continue;
    }
    // 旧版・手動作成チャンネルの role allow が @everyone deny を上書きしても、
    // member 固有 allow を持たない人は閲覧できないようにする。
    if (overwrite.id !== guild.roles.everyone.id) {
      await channel.permissionOverwrites.edit(overwrite.id, {
        ViewChannel: false,
      }, { reason: ACCESS_SYNC_REASON });
    }
  }

  const desired = new Set(allowed);
  desired.add(botId);

  const added: string[] = [];
  for (const id of desired) {
    // edit は既存 overwrite に対しても必要。存在だけを見て skip すると、旧 deny や
    // bot の SendMessages 欠落を修復できない。
    await channel.permissionOverwrites.edit(id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      ...(id === botId ? { SendMessages: true, EmbedLinks: true } : {}),
    }, { reason: ACCESS_SYNC_REASON });
    if (!existing.has(id)) added[added.length] = id;
  }

  const removed: string[] = [];
  for (const id of existing) {
    if (desired.has(id)) continue;
    await channel.permissionOverwrites.delete(id, ACCESS_SYNC_REASON);
    removed[removed.length] = id;
  }

  return { allowed, added, removed };
}

/**
 * `管理` 面を作るときの初期 overwrite。
 *
 * `@everyone` の ViewChannel を deny するのがこの面の本体。 作成と同時に閉じないと、
 * 作成から同期までの隙間で誰でも見られる瞬間ができる。
 */
export function managementChannelOverwrites(input: {
  guild: Guild;
  viewerIds: readonly string[];
}): { id: string; deny?: bigint[]; allow?: bigint[] }[] {
  const botId = managementBotId(input.guild);
  const overwrites: { id: string; deny?: bigint[]; allow?: bigint[] }[] = [
    { id: input.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
  ];
  for (const id of input.viewerIds) {
    // bot が名簿にも登録されていても、同じ ID の overwrite を二重に渡さない。
    if (id === botId) continue;
    overwrites[overwrites.length] = {
      id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    };
  }
  overwrites[overwrites.length] = {
    id: botId,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ],
  };
  return overwrites;
}

function managementBotId(guild: Guild): string {
  const botId = guild.client.user?.id;
  if (!botId) throw new Error("Discord bot user is unavailable during management access sync");
  return botId;
}
