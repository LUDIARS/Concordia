/**
 * 社員名簿の人を、 その guild に在籍する人へ絞る (spec/feature/staff-roster.md §9)。
 *
 * 社員名簿は本社と子会社で共通で、 誰がどの会社に属するかは持たない。 所属はその guild の
 * メンバーかどうかで判断する (2026-10-02 neco 指示「サーバにいないメンバーへのメンションはしない」)。
 * 在籍しない (Unknown Member) は外し、 それ以外の取得失敗は投げ返す — 確かめられないまま
 * メンションや閲覧権限を決めない。
 *
 * @implements SPEC-STAFF-GUILD-MEMBERS
 */

import type { Guild } from "discord.js";

/** Discord の Unknown Member。 */
const UNKNOWN_MEMBER = 10007;

export async function guildMemberIds(
  guild: Pick<Guild, "members">,
  candidateIds: readonly string[],
): Promise<string[]> {
  const present: string[] = [];
  for (const id of new Set(candidateIds)) {
    try {
      await guild.members.fetch(id);
      present.push(id);
    } catch (error) {
      if ((error as { code?: unknown }).code === UNKNOWN_MEMBER) continue;
      throw error;
    }
  }
  return present;
}
