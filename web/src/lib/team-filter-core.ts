/**
 * チーム選択 (グローバルフィルタ) の純ロジック。
 * 永続化キーと、 保存値 ⇄ 現存チームの突き合わせを UI から切り離してテスト可能にする。
 */

export const TEAM_FILTER_STORAGE_KEY = "concordia.team-filter.v1";

/** localStorage の raw 値を正規化する (空文字・空白は未選択扱い)。 */
export function readStoredTeamId(raw: string | null): string | null {
  const value = raw?.trim();
  return value && value.length <= 200 ? value : null;
}

/**
 * 保存された選択をチーム一覧へ突き合わせる。
 * 削除済みチーム (一覧に無い id) は未選択へ落とし、 幽霊フィルタを残さない。
 */
export function resolveSelectedTeamId(
  storedId: string | null,
  teams: ReadonlyArray<{ id: string }>,
): string | null {
  if (!storedId) return null;
  return teams.some((team) => team.id === storedId) ? storedId : null;
}
