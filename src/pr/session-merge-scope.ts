/**
 * セッションからの local PR マージを「同じプロジェクトで作業しているセッションか」で
 * 絞る判定 (純関数)。
 *
 * マージは人間の判断が要る操作で、 セッションが自分の判断で (Genius や他の AI の助言を
 * 含め) マージすることは無い。 したがって指示者の解決と `merge_pr` は必須のまま残す。
 *
 * この判定はそこへ **追加** する制約である。 権限のある指示者であっても、 その session が
 * 作業していないプロジェクトの PR を横から落とせないようにする。 認可の代わりではない。
 *
 * SRP: repo 表記の突き合わせ判定のみ。 DB / Revisor / HTTP アクセスは呼び出し側。
 */

import { normalizeRepoOrigin } from "./normalize.js";

export type SessionMergeScopeDenial =
  /** session_id に対応する session 行が無い。 */
  | "session_unknown"
  /** session が repo_origin を登録していない (どの project か名乗っていない)。 */
  | "session_repo_unknown"
  /** Revisor から対象 local PR の repository を読めない。 */
  | "local_pr_repo_unknown"
  /** session の project と PR の project が違う。 */
  | "project_mismatch";

export type SessionMergeScope =
  | { allowed: true; project: string }
  | { allowed: false; reason: SessionMergeScopeDenial; detail: string };

/**
 * 突き合わせは正規化した `owner/repo` の大小文字無視で行う。 同じリポジトリが
 * `https://github.com/LUDIARS/Concordia.git` と `LUDIARS/Concordia` の両表記で
 * 流れてくるうえ、 Windows 側の記録は大小文字が揺れるため、 表記差を「別プロジェクト」
 * と誤判定すると、 直したいときに限ってマージできないという同じ不安定さに戻る。
 */
export function decideSessionMergeScope(input: {
  sessionRepoOrigin?: string | null;
  localPrRepository?: string | null;
  /** session 行そのものを引けたか。 引けない場合は突き合わせる相手がいない。 */
  sessionFound?: boolean;
}): SessionMergeScope {
  if (input.sessionFound === false) {
    return {
      allowed: false,
      reason: "session_unknown",
      detail: "マージを要求した session を Concordia が把握していません。",
    };
  }
  const sessionProject = normalizeRepoOrigin(input.sessionRepoOrigin ?? "");
  if (!sessionProject) {
    return {
      allowed: false,
      reason: "session_repo_unknown",
      detail: "session に repo_origin が登録されていないため、 作業中のプロジェクトを確定できません。",
    };
  }
  const prProject = normalizeRepoOrigin(input.localPrRepository ?? "");
  if (!prProject) {
    return {
      allowed: false,
      reason: "local_pr_repo_unknown",
      detail: "対象 local PR のリポジトリを Revisor から解決できませんでした。",
    };
  }
  if (sessionProject.toLowerCase() !== prProject.toLowerCase()) {
    return {
      allowed: false,
      reason: "project_mismatch",
      detail: `session は ${sessionProject} で作業しています。 ${prProject} の PR はそのプロジェクトのセッションからマージしてください。`,
    };
  }
  return { allowed: true, project: sessionProject };
}
