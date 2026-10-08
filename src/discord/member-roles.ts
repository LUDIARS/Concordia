/**
 * 月次予算の属性の倍率に使う Discord のロールを、 Bot (本社・子会社) が在籍する guild から読む
 * (spec/feature/usage-budgets.md §3.1 §6)。
 *
 * - 人のロール: Bot が在籍する全 guild でその人の member を引き、 持っているロール id を集める。
 * - guild のロール一覧: WebUI の倍率の設定画面に名前つきで出す。
 * どちらも @everyone (ロール id = guild id) と連携アプリが管理するロール (Bot のロール等) は除く。
 * cost 層は Discord を import しないので、 bootstrap がここを関数として差し込む。
 *
 * @implements SPEC-USAGE-BUDGET-MULTIPLIER
 */

/** Discord の Unknown Member。 */
const UNKNOWN_MEMBER = 10007;

interface RoleLike {
  id: string;
  name: string;
  managed?: boolean;
  position?: number;
}

interface CacheLike<T> {
  values(): Iterable<T>;
}

export interface RoleGuildLike {
  id: string;
  name: string;
  roles: { cache: CacheLike<RoleLike> };
  members: { fetch(userId: string): Promise<{ roles: { cache: CacheLike<{ id: string }> } }> };
}

export interface RoleClientLike {
  guilds: { cache: CacheLike<RoleGuildLike> };
}

export interface GuildRoleList {
  guild_id: string;
  guild_name: string;
  roles: Array<{ id: string; name: string }>;
}

function guildsOf(clients: readonly RoleClientLike[]): RoleGuildLike[] {
  // 本社と子会社は同じ Client を共有することがある (gateway-pool)。 guild id で重複を除く。
  const byId = new Map<string, RoleGuildLike>();
  for (const client of clients) {
    for (const guild of client.guilds.cache.values()) byId.set(guild.id, guild);
  }
  return [...byId.values()];
}

/**
 * その人が持つロール id (Bot が在籍する全 guild の分)。 Bot が 1 つも動いていなければ null (分からない)。
 * 在籍しない guild (Unknown Member) は飛ばし、 それ以外の取得失敗は投げ返す (呼び出し側が倍率 1 に倒す)。
 */
export async function memberRoleIds(clients: readonly RoleClientLike[], userId: string): Promise<string[] | null> {
  if (clients.length === 0) return null;
  const roleIds = new Set<string>();
  for (const guild of guildsOf(clients)) {
    let member;
    try {
      member = await guild.members.fetch(userId);
    } catch (error) {
      if ((error as { code?: unknown }).code === UNKNOWN_MEMBER) continue;
      throw error;
    }
    for (const role of member.roles.cache.values()) {
      if (role.id !== guild.id) roleIds.add(role.id);
    }
  }
  return [...roleIds];
}

/** guild ごとのロール一覧 (名前つき、 上位のロールから)。 */
export function listGuildRoles(clients: readonly RoleClientLike[]): GuildRoleList[] {
  return guildsOf(clients)
    .map((guild) => ({
      guild_id: guild.id,
      guild_name: guild.name,
      roles: [...guild.roles.cache.values()]
        .filter((role) => role.id !== guild.id && role.managed !== true)
        .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
        .map((role) => ({ id: role.id, name: role.name })),
    }))
    .sort((a, b) => (a.guild_name < b.guild_name ? -1 : a.guild_name > b.guild_name ? 1 : 0));
}
