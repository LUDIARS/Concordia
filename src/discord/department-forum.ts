/**
 * 部署フォーラムの用意 (spec/feature/departments.md §9.3)。
 *
 * 所有会社の guild の「部署」カテゴリに、 既定でない部署ごとのフォーラムを冪等に用意する。
 * 既定部署は Session フォーラムをそのまま使うので作らない。 廃止した部署のフォーラムは
 * 残す (作り直さない・改名しない)。 チームの面と同じく必須タグ (セッション状態・Cc 管理) も揃える。
 * @implements SPEC-DEPT-FORUM
 */

import { ChannelType, type ForumChannel, type Guild } from "discord.js";
import { ensureTeamForumTags } from "./team-provision.js";

export const DEPARTMENT_CATEGORY_NAME = "部署";

export interface DepartmentForumTarget {
  id: string;
  name: string;
  subsidiary_id: string | null;
  discord_forum_id: string | null;
  is_default: number;
  archived_at: number | null;
}

export interface DepartmentForumStore {
  /** この guild (論理 runtime) の部署カテゴリ id。 */
  categoryId(): string | null;
  setCategoryId(id: string): void;
  setForumId(departmentId: string, forumId: string): void;
}

/** 部署が自社の既定でない稼働中の部署として、 フォーラムを持つべきか。 */
export function needsDepartmentForum(department: DepartmentForumTarget, runtimeSubsidiaryId: string | null): boolean {
  return department.subsidiary_id === runtimeSubsidiaryId
    && department.is_default !== 1
    && department.archived_at === null;
}

/**
 * 部署セッションのスレッドを置くフォーラム。 チームの面より後、 Session フォーラムより前に
 * 引く (呼び出し側がチームの解決へ fallback として渡す)。 自社所有でない部署・既定部署・
 * フォーラム未作成は fallback のまま。
 */
export function departmentSessionForumId(
  department: DepartmentForumTarget | null,
  runtimeSubsidiaryId: string | null,
  fallbackForumId: string,
): string {
  if (!department || department.subsidiary_id !== runtimeSubsidiaryId) return fallbackForumId;
  if (department.is_default === 1 || !department.discord_forum_id) return fallbackForumId;
  return department.discord_forum_id;
}

/**
 * Session フォーラムの表示名 (departments.md §9.2)。 既定部署は Session フォーラムを自部署の面に
 * するので、 その部署名に揃える。 自社所有の稼働中の既定部署が無ければ undefined (レイアウト側の
 * 既定名「Session」に戻る)。
 * @implements SPEC-DEPT-DEFAULT
 */
export function sessionForumNameFor(
  defaultDepartment: DepartmentForumTarget | null,
  runtimeSubsidiaryId: string | null,
): string | undefined {
  if (!defaultDepartment || defaultDepartment.subsidiary_id !== runtimeSubsidiaryId) return undefined;
  if (defaultDepartment.is_default !== 1 || defaultDepartment.archived_at !== null) return undefined;
  return defaultDepartment.name.trim() || undefined;
}

export async function ensureDepartmentForum(input: {
  guild: Guild;
  store: DepartmentForumStore;
  department: DepartmentForumTarget;
}): Promise<string> {
  const categoryId = await resolveCategory(input);
  const forum = await resolveForum(input, categoryId);
  await ensureTeamForumTags(forum);
  if (forum.id !== input.department.discord_forum_id) input.store.setForumId(input.department.id, forum.id);
  return forum.id;
}

async function resolveCategory(input: { guild: Guild; store: DepartmentForumStore }): Promise<string> {
  const stored = input.store.categoryId();
  if (stored) {
    const existing = await input.guild.channels.fetch(stored).catch(() => null);
    if (existing?.type === ChannelType.GuildCategory) return existing.id;
  }
  // 部署カテゴリは guild に 1 つだけなので、 同名の既存カテゴリがあれば引き継ぐ。
  const sameName = input.guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && channel.name === DEPARTMENT_CATEGORY_NAME);
  const category = sameName
    ?? await input.guild.channels.create({ name: DEPARTMENT_CATEGORY_NAME, type: ChannelType.GuildCategory });
  input.store.setCategoryId(category.id);
  return category.id;
}

async function resolveForum(
  input: { guild: Guild; department: DepartmentForumTarget },
  categoryId: string,
): Promise<ForumChannel> {
  const { department } = input;
  if (department.discord_forum_id) {
    const existing = await input.guild.channels.fetch(department.discord_forum_id).catch(() => null);
    if (existing?.type === ChannelType.GuildForum) {
      // 利用者がカテゴリを移していても尊重し、 名前だけ部署名に揃える。
      return existing.name === department.name ? existing : existing.setName(department.name);
    }
  }
  const sameName = input.guild.channels.cache.find((channel) =>
    channel.parentId === categoryId && channel.type === ChannelType.GuildForum && channel.name === department.name);
  if (sameName?.type === ChannelType.GuildForum) return sameName;
  return input.guild.channels.create({ name: department.name, type: ChannelType.GuildForum, parent: categoryId });
}
