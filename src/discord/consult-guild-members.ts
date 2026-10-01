/**
 * プライベート相談の閲覧者候補を、 その guild に在籍する人へ絞る (spec/feature/tech-consultation.md §6)。
 *
 * 社員名簿は本社と子会社で共通なので、 子会社 guild には居ない権限者がいる。 居ない人の member overwrite を
 * 作成要求に含めるとチャンネル作成ごと失敗するため、 作成前に在籍を確かめる。 在籍しない (Unknown Member) は
 * 外し、 それ以外の取得失敗は投げ返す — 確かめられないまま閲覧者を決めない。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import type { Guild } from "discord.js";

/** Discord の Unknown Member。 */
const UNKNOWN_MEMBER = 10007;

export async function consultGuildMemberIds(
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
