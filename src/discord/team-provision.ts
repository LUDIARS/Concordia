import type Database from "better-sqlite3";
import {
  ChannelType,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type GuildChannel,
  type GuildForumTagData,
} from "discord.js";
import { SESSION_STATE_TAG_NAMES } from "./config.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";
import { SESSION_RUNTIME_RULE_TAG_NAMES } from "./forum-template-tags.js";
import {
  managementChannelOverwrites,
  managementViewerIds,
  syncManagementAccess,
} from "./team-management-access.js";

/**
 * @implements spec/feature/teams.md §2
 *
 * カード種別の出力先 (team-card-routing.ts) はこの集合の中から選ぶ必要があるので export する。
 * テスト側が写しを手書きすると、 面を足したときに片方だけ古くなって
 * 「存在しない面へ張る」を見逃す。
 */
export const SURFACES = ["目標", "タスクボード", "コスト", "direction", "management", "セッション", "タスク"] as const;

type TeamSurface = typeof SURFACES[number];

const FORUM_SURFACES = new Set<TeamSurface>(["セッション", "タスク"]);

/**
 * 権限者だけが見られる面。 `@everyone` の ViewChannel を deny し、 社員名簿で
 * manager / executive の Discord ユーザにだけ許可する。
 */
const RESTRICTED_SURFACES = new Set<TeamSurface>(["management"]);

/**
 * チーム forum がセッションスレッドの受け皿になるための必須タグ。
 * createForumSessionThread は状態タグと Cc管理タグが無い forum に対して throw するため、
 * global forum (config.ts の ensureForum) と同じ必須集合をチーム forum にも用意する。
 */
const TEAM_FORUM_TAG_NAMES: readonly string[] = [
  ...Object.values(SESSION_STATE_TAG_NAMES),
  ...SESSION_RUNTIME_RULE_TAG_NAMES,
  CONCORDIA_MANAGED_FORUM_TAG_NAME,
];

export async function ensureTeamDiscordLayout(input: {
  guild: Guild;
  db: Database.Database;
  teamId: string;
  name: string;
}): Promise<void> {
  const category = await resolveCategory(input);
  input.db.prepare(
    "UPDATE teams SET discord_category_id = ?, updated_at = ? WHERE id = ?",
  ).run(category.id, Date.now(), input.teamId);

  for (const surface of SURFACES) {
    const channel = await resolveSurface(input, category.id, surface);
    // タグ付与は forum 生成と分けて毎回流す。 既存チーム (タグ無しで作られた forum) にも
    // 追いつかせるため、 新規作成時だけでなく再解決時にも不足分を補う。
    if (FORUM_SURFACES.has(surface)) await ensureTeamForumTags(channel as ForumChannel);
    // 権限者限定の面は、 作成時だけでなく毎回名簿と突き合わせる。 昇格した人を足すだけでは
    // なく、 降格・名簿削除された人の古い許可も外さないと権限者限定として壊れている。
    if (RESTRICTED_SURFACES.has(surface)) {
      // resolveSurface はカテゴリ直下のチャンネルしか返さないのでスレッドにはならない。
      await syncManagementAccess({
        guild: input.guild,
        channel: channel as GuildChannel,
        db: input.db,
      });
    }
    input.db.prepare(`
      INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, ?, ?)
      ON CONFLICT(team_id, surface) DO UPDATE SET channel_id = excluded.channel_id
    `).run(input.teamId, surface, channel.id);
  }
}

async function resolveCategory(input: {
  guild: Guild;
  db: Database.Database;
  teamId: string;
  name: string;
}): Promise<GuildBasedChannel> {
  const stored = input.db.prepare(
    "SELECT discord_category_id FROM teams WHERE id = ?",
  ).get(input.teamId) as { discord_category_id: string | null } | undefined;
  if (stored?.discord_category_id) {
    const existing = await input.guild.channels.fetch(stored.discord_category_id).catch(() => null);
    if (existing?.type === ChannelType.GuildCategory) {
      return existing.name === input.name ? existing : existing.setName(input.name);
    }
  }
  // Team names need not be unique. Never adopt an unrelated same-name category.
  return input.guild.channels.create({ name: input.name, type: ChannelType.GuildCategory });
}

async function resolveSurface(
  input: { guild: Guild; db: Database.Database; teamId: string },
  categoryId: string,
  surface: TeamSurface,
): Promise<GuildBasedChannel> {
  const desiredType = FORUM_SURFACES.has(surface)
    ? ChannelType.GuildForum
    : ChannelType.GuildText;
  const stored = input.db.prepare(
    "SELECT channel_id FROM team_surfaces WHERE team_id = ? AND surface = ?",
  ).get(input.teamId, surface) as { channel_id: string } | undefined;
  if (stored) {
    const existing = await input.guild.channels.fetch(stored.channel_id).catch(() => null);
    if (existing?.parentId === categoryId && existing.type === desiredType) return existing;
  }

  const name = surface === "management"
    ? "管理"
    : FORUM_SURFACES.has(surface) ? `${surface}フォーラム` : surface;
  const existing = input.guild.channels.cache.find((channel) =>
    channel.parentId === categoryId && channel.name === name && channel.type === desiredType
  );
  if (existing) return existing;
  // 権限者限定の面は**作成と同時に閉じる**。 作ってから同期すると、 その隙間だけ
  // 誰でも見られる瞬間ができる。
  const permissionOverwrites = RESTRICTED_SURFACES.has(surface)
    ? managementChannelOverwrites({
        guild: input.guild,
        viewerIds: managementViewerIds(input.db),
      })
    : undefined;
  return input.guild.channels.create({
    name,
    type: desiredType,
    parent: categoryId,
    ...(permissionOverwrites ? { permissionOverwrites } : {}),
  });
}

/**
 * チーム forum に不足している必須タグだけを足す (既存タグ・利用者タグは保持)。
 * ここで throw するとチーム面のプロビジョニング全体が止まるので、
 * 呼び出し側の運用を守るため冪等・追加のみに限定する。
 */
async function ensureTeamForumTags(forum: ForumChannel): Promise<void> {
  const missing = TEAM_FORUM_TAG_NAMES.filter(
    (name) => !forum.availableTags.some((tag) => tag.name === name),
  );
  if (missing.length === 0) return;
  const tags: GuildForumTagData[] = [
    ...forum.availableTags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      moderated: tag.moderated,
      emoji: tag.emoji ?? undefined,
    })),
    ...missing.map((name) => ({ name, moderated: false })),
  ];
  await forum.setAvailableTags(tags, "Concordia team forum layout sync");
}
