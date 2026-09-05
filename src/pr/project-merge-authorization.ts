/**
 * local PR マージの認可を「マージ対象のプロジェクト」で判定する (純関数)。
 *
 * ## なぜ置き換えたか
 *
 * 旧のセッションスコープ判定は「セッションの `repo_origin` と PR の `repository` が
 * 一致すること」を要求していた。狙いは「権限を持つ指示者でも他プロジェクトの PR を
 * 横から落とせないようにする」ことだったが、認可として働いていなかった
 * (neco 指示 2026-09-05)。
 *
 * - 横断作業は Castra (workspace root) を cwd にするため `repo_origin` が
 *   `LUDIARS/Castra` に固定され、どのプロジェクトの PR もマージできない
 *   (Ludellus / Ludellus-Server の PR が `merge_project_scope_denied` で停止した)。
 * - 回避も自明で、`PATCH /v1/sessions/:id` で `repo_path` / `repo_origin` を書き換えれば
 *   そのまま通る。実際に 2026-09-05 にこの手順で #1389 / #1390 がマージされた。
 *   **セッションの自己申告を書き換えるだけで満たせる条件は、認可の境界にならない。**
 *
 * ## 置き換えた規則
 *
 * セッションの申告は一切見ない。見るのは対象 PR が属するプロジェクトだけで、
 * それが **Cc が管理しているプロジェクトであること** を要求する。管理集合は
 * `project_codes` (WebUI `/projects` から明示登録) と `team_repos` (team への repo 割当)
 * という、セッション行の自己申告とは別に管理される既存の運用データである。
 *
 * これにより:
 *
 * - Castra を cwd にした横断セッションから、登録を書き換えずにマージできる
 *   (セッションを見ないので cwd は無関係)
 * - Cc の管理外リポジトリの PR は、指示者が権限を持っていても通らない
 * - `PATCH /v1/sessions/:id` での自己申告書き換えは結果に影響しない
 *
 * ## 認可の範囲についての注意
 *
 * 「直近の人間指示者 + `merge_pr`」は呼び出し側に残っている。マージは人間の判断が要る
 * 実行点で、この変更はそこを緩めるものではない。
 *
 * ただし `merge_pr` は社員名簿の役職 (staff / manager / executive) で決まる **全社共通**の
 * 権限で、Cc は「この人はこのプロジェクトだけ」という人×プロジェクトの対応表を持って
 * いない (`staff_members` に team / subsidiary 列は無く、`team_repos` に人の所属も無い)。
 * したがってここで言う「プロジェクトに対する権限」は
 * 「`merge_pr` を持つ人 × Cc の管理下にあるプロジェクト」までであり、人ごとの
 * プロジェクト絞り込みではない。それを入れるには新しい設定面が要る。
 *
 * SRP: 判定のみ。DB / Revisor / HTTP アクセスは呼び出し側。
 */

import { isOwnerRepo, normalizeRepoOrigin } from "./normalize.js";

export type ProjectMergeDenial =
  /** Revisor から対象 local PR の repository を読めない。 */
  | "local_pr_repo_unknown"
  /** PR の repository が Cc の管理下に無い (project_codes にも team_repos にも無い)。 */
  | "project_not_registered";

/** プロジェクトをどの登録から確認できたか。 監査ログに残す。 */
export type ProjectRegistrationSource = "project_codes" | "team_repos";

export type ProjectMergeAuthorization =
  | { allowed: true; project: string; via: ProjectRegistrationSource }
  | { allowed: false; reason: ProjectMergeDenial; detail: string };

export interface ProjectMergeAuthorizationInput {
  /** 対象 local PR の repository。 Revisor が正本。 */
  localPrRepository?: string | null;
  /** `project_codes` に repo_origin として登録されているか。 */
  isRegisteredProject(repoOrigin: string): boolean;
  /** いずれかの team に repo_origin が割り当てられているか。 */
  isTeamRepo?(repoOrigin: string): boolean;
}

/**
 * 対象 PR のプロジェクトがマージを許される集合に入っているかを判定する。
 * @implements spec/feature/local-pr-merge-authorization.md — managed-project boundary
 *
 * 突き合わせは正規化した `owner/repo` で行う。同じリポジトリが
 * `https://github.com/LUDIARS/Concordia.git` と `LUDIARS/Concordia` の両表記で流れてくる
 * うえ Windows 側の記録は大小文字が揺れるため、表記差を「別プロジェクト」と誤判定すると
 * 直したいときに限ってマージできない、という元の不安定さに戻る。
 */
export function decideProjectMergeAuthorization(
  input: ProjectMergeAuthorizationInput,
): ProjectMergeAuthorization {
  const project = normalizeMergeProject(input.localPrRepository);
  if (!project) {
    return {
      allowed: false,
      reason: "local_pr_repo_unknown",
      detail: "対象 local PR のリポジトリを Revisor から解決できませんでした。",
    };
  }
  if (input.isRegisteredProject(project)) {
    return { allowed: true, project, via: "project_codes" };
  }
  if (input.isTeamRepo?.(project)) {
    return { allowed: true, project, via: "team_repos" };
  }
  return {
    allowed: false,
    reason: "project_not_registered",
    detail:
      `${project} は Concordia の管理下にあるプロジェクトとして登録されていません。`
      + " /projects でプロジェクトコードに repo_origin を登録するか、 team に repo を割り当ててからマージしてください。",
  };
}

/**
 * 認可キーとして受け入れるのは owner/repo と GitHub origin だけ。
 * 汎用の normalizeRepoOrigin は解釈不能な文字列を原文のまま返し、任意 host の URL も
 * owner/repo に畳むため、そのまま使うとローカルパスの反射漏洩や host 間の取り違えになる。
 */
function normalizeMergeProject(repository: string | null | undefined): string | null {
  const raw = repository?.trim() ?? "";
  if (!raw) return null;
  if (!isMergeOwnerRepo(raw)
    && !/^https?:\/\/github\.com\//i.test(raw)
    && !/^git@github\.com:/i.test(raw)) {
    return null;
  }
  const normalized = normalizeRepoOrigin(raw);
  return isMergeOwnerRepo(normalized) ? normalized : null;
}

function isMergeOwnerRepo(value: string): boolean {
  if (!isOwnerRepo(value)) return false;
  const [owner, name] = value.split("/");
  return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}
