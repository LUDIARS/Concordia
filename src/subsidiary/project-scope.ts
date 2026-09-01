/**
 * 子会社の「関係 project」で Revisor local PR の掲載範囲を絞る純粋ロジック。
 *
 * 子会社 (出張先 guild) の Test forum に本社の全 PR を出すと、 その子会社に無関係な
 * リポジトリの branch 名・PR タイトル・審査内容がそのまま外部サーバへ漏れる。
 * 掲載側は必ずこのフィルタを通す (2026-09-01 neco 指示)。
 *
 * @implements spec/feature/subsidiary-delegation.md §3.4
 */

/** `https://github.com/LUDIARS/Concordia.git` / `LUDIARS/Concordia` → `Concordia`。 */
export function projectOfRepoOrigin(repoOrigin: string): string {
  const last = repoOrigin.replace(/\/+$/, "").split("/").pop() ?? repoOrigin;
  return last.replace(/\.git$/i, "");
}

/**
 * project 名が関係 project の集合に入るか。
 * 集合が空 = 未設定は常に false — 未設定を全許可にすると設定漏れがそのまま
 * 全 PR の漏洩・全リポへの作業起動になるため、 安全側 (無言フォールバック禁止) に倒す。
 * project 名が空 / 未解決のときも false (確認できないものを通さない)。
 */
export function isProjectNameInScope(
  project: string | null | undefined,
  projects: readonly string[],
): boolean {
  if (projects.length === 0) return false;
  const name = (project ?? "").trim().toLowerCase();
  if (!name) return false;
  return projects.some((p) => p.trim().toLowerCase() === name);
}

/** 掲載可否。 子会社 (scope 有り) は関係 project の集合に入る PR だけ。 */
export function isProjectInScope(repoOrigin: string, projects: readonly string[]): boolean {
  return isProjectNameInScope(projectOfRepoOrigin(repoOrigin), projects);
}

/** repoOrigin を持つ候補列を関係 project だけに絞る。 */
export function filterByProjectScope<T extends { repoOrigin: string }>(
  items: readonly T[],
  projects: readonly string[],
): T[] {
  return items.filter((item) => isProjectInScope(item.repoOrigin, projects));
}
