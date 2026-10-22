/**
 * セッションの「作業リポ」の決め方。
 *
 * Castra root で起動したセッションや、調査のために別リポへ cwd を移したセッションでは
 * `repo_path` (Lictor が直近に触れたリポを送ってくる) が宣言した作業対象 `target_project`
 * と食い違う。プロジェクト単位の紐づけ (Actio task の project binding 等) は宣言された
 * 作業対象を正とし、 cwd の観測だけで別リポへ移さない。
 *
 * @implements SPEC-SESSION-WORKING-REPO-BINDING
 */

export interface SessionWorkingRepoFields {
  repo_path: string;
  target_project?: string | null;
}

/**
 * プロジェクト単位の紐づけに使う作業リポ。宣言された target_project を優先する。
 *
 * @implements SPEC-SESSION-WORKING-REPO-BINDING
 */
export function sessionWorkingRepoPath(session: SessionWorkingRepoFields): string {
  return session.target_project?.trim() || session.repo_path;
}

export interface DeclaredTargetPatch {
  repo_path?: string;
  repo_origin?: string | null;
  branch?: string;
  target_project?: string | null;
}

export interface DeclaredTargetIo {
  /** worktree を本体リポへ正規化した同一性キー。 */
  repoKey(path: string): Promise<string>;
  /** checkout の現在 branch (読めなければ null)。 */
  currentBranch(path: string): Promise<string | null>;
}

export interface DeclaredTargetDecision {
  /** patch から落とす列。 */
  drop: Array<"repo_path" | "repo_origin" | "branch">;
  reason: "outside_target_repo" | "branch_not_checked_out" | null;
}

const KEEP: DeclaredTargetDecision = { drop: [], reason: null };

/**
 * target_project を宣言したセッションへの cwd 由来の更新から、作業対象外のリポへの移動を落とす。
 *
 * - patch 自体が target_project を変えるなら作業対象の付け替えなので触らない。
 * - repo_path が作業対象と別リポ (worktree は同じリポ扱い) なら repo_path / repo_origin / branch を落とす。
 * - branch だけの更新は、現在の作業リポの実 branch と一致するときだけ通す
 *   (Lictor は別リポへ移った後、そのリポの branch を単独で送ってくる)。
 * - 判定に必要な読み取りが失敗したら従来どおり通す (登録を止めない)。
 *
 * @implements SPEC-SESSION-WORKING-REPO-BINDING
 */
export async function decideDeclaredTargetPatch(
  session: { repo_path: string; target_project: string | null },
  patch: DeclaredTargetPatch,
  io: DeclaredTargetIo,
): Promise<DeclaredTargetDecision> {
  const target = session.target_project?.trim();
  if (!target || patch.target_project !== undefined) return KEEP;
  try {
    const targetKey = await io.repoKey(target);
    if (patch.repo_path !== undefined) {
      if (await io.repoKey(patch.repo_path) === targetKey) return KEEP;
      return { drop: ["repo_path", "repo_origin", "branch"], reason: "outside_target_repo" };
    }
    if (patch.branch === undefined) return KEEP;
    if (await io.repoKey(session.repo_path) !== targetKey) return KEEP;
    const actual = await io.currentBranch(session.repo_path);
    if (actual === null || actual === patch.branch) return KEEP;
    return { drop: ["branch"], reason: "branch_not_checked_out" };
  } catch {
    return KEEP;
  }
}
