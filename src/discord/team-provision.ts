import type Database from "better-sqlite3";
import { ChannelType, type Guild, type GuildBasedChannel } from "discord.js";

/** @implements spec/feature/teams.md §2 */
const SURFACES = ["目標", "タスクボード", "コスト", "direction", "セッション", "タスク"] as const;

type TeamSurface = typeof SURFACES[number];

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
  const desiredType = surface === "セッション" || surface === "タスク"
    ? ChannelType.GuildForum
    : ChannelType.GuildText;
  const stored = input.db.prepare(
    "SELECT channel_id FROM team_surfaces WHERE team_id = ? AND surface = ?",
  ).get(input.teamId, surface) as { channel_id: string } | undefined;
  if (stored) {
    const existing = await input.guild.channels.fetch(stored.channel_id).catch(() => null);
    if (existing?.parentId === categoryId && existing.type === desiredType) return existing;
  }

  const name = surface === "セッション" || surface === "タスク" ? `${surface}フォーラム` : surface;
  const existing = input.guild.channels.cache.find((channel) =>
    channel.parentId === categoryId && channel.name === name && channel.type === desiredType
  );
  return existing ?? input.guild.channels.create({
    name,
    type: desiredType,
    parent: categoryId,
  });
}
