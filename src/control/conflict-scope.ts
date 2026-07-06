/**
 * 作業衝突 (同一プロジェクトを複数セッションが同時に触る) の判定スコープ。
 *
 * 従来は session.repo_path (= wrapped agent の cwd の git repo) をそのまま衝突キーに
 * していた。 だが LUDIARS ワークスペースは直下 (E:/Document/Ars) 自体が git repo で
 * あり、 多くのセッションが cwd=ルートで起動する。 それらを repo_path で束ねると全員が
 * 相互に「同 repo/branch」 衝突扱いになりノイズになる (umbrella を個別プロジェクトと
 * 誤認)。
 *
 * そこで衝突キーを次で決める:
 *   1. session が `target_project` を宣言していればそれ (= 実際に扱う個別プロジェクト)。
 *      cwd がルートでも、 宣言した個別プロジェクト単位で衝突監視する。
 *   2. 未宣言で repo_path がワークスペースルートなら null (= umbrella。 衝突監視しない)。
 *   3. それ以外は repo_path (= 子リポを直接 cwd にした通常ケース。 従来どおり)。
 *
 * 純関数のみ。 呼び出し側 (lifecycle / collaboration-context) が active session 一覧と
 * workspaceRoots を渡す。
 */

/** パス/識別子の正規化 (Windows の `\`/`/` 揺れ・末尾スラッシュ・大文字小文字を吸収)。 */
export function normalizeRepoKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** repo_path が設定済ワークスペースルートのいずれかと一致するか (= umbrella)。 */
export function isWorkspaceRootRepo(repoPath: string, workspaceRoots: readonly string[]): boolean {
  if (!repoPath) return false;
  const key = normalizeRepoKey(repoPath);
  return workspaceRoots.some((r) => !!r && normalizeRepoKey(r) === key);
}

export interface ConflictScopeSession {
  repo_path: string;
  target_project: string | null;
}

/**
 * このセッションの衝突キー (null = 衝突監視対象外)。 上記 3 ルール。
 */
export function conflictRepoKey(
  session: ConflictScopeSession,
  workspaceRoots: readonly string[],
): string | null {
  const declared = session.target_project?.trim();
  if (declared) return normalizeRepoKey(declared);
  if (isWorkspaceRootRepo(session.repo_path, workspaceRoots)) return null;
  return normalizeRepoKey(session.repo_path);
}

/**
 * 衝突監視上の peer (同一衝突キーの他 active session)。 キーが null なら空
 * (umbrella ルートで個別プロジェクト未宣言 → 誰とも衝突しない)。
 * branch 一致による branch_conflict 判定は呼び出し側が peers から行う (従来どおり)。
 */
export function findConflictPeers<
  T extends ConflictScopeSession & { id: string; status: string },
>(
  session: ConflictScopeSession & { id: string },
  activeSessions: readonly T[],
  workspaceRoots: readonly string[],
): T[] {
  const key = conflictRepoKey(session, workspaceRoots);
  if (key === null) return [];
  return activeSessions.filter(
    (p) => p.id !== session.id && p.status === "active" && conflictRepoKey(p, workspaceRoots) === key,
  );
}
