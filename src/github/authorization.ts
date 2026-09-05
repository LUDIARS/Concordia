/**
 * 発火してよいかの判定 (純関数)。
 *
 * Issue は誰でも立てられる外部入力なので、 「登録済み opt-in プロジェクト」と
 * 「信頼できる実行者」の 2 段を両方満たしたときだけ通す。 判定できない材料は
 * すべて拒否側へ倒す (fail-closed)。
 *
 * @implements spec/feature/github-issue-workflow.md — 契約
 */

import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";

export type AuthorizationVerdict =
  /** そのまま実行してよい。 */
  | { kind: "allow"; project: ProjectCodeRow }
  /**
   * 対象リポジトリではあるが、 起票者もラベル付与者も信頼実行者ではない。
   * 握り潰さず人間の承認を待つ (2026-09-05 neco 指示)。
   */
  | { kind: "needs_approval"; project: ProjectCodeRow; detail: string }
  /** そもそも対象外。 run も作らない。 */
  | { kind: "reject"; reason: "project_unregistered" | "project_opted_out"; detail: string };

/**
 * project_codes の repo_origin (URL 表記も owner/name 表記もありうる) と webhook の
 * `owner/name` を突き合わせる。 表記差は PR 側と同じ normalizeRepoOrigin で畳む。
 */
export function findProjectByRepository(
  projects: readonly ProjectCodeRow[],
  repoOrigin: string,
): ProjectCodeRow | null {
  const wanted = normalizeRepoOrigin(repoOrigin).toLowerCase();
  if (!wanted) return null;
  return projects.find(
    (project) => normalizeRepoOrigin(project.repo_origin ?? "").toLowerCase() === wanted,
  ) ?? null;
}

export function authorizeIssueTrigger(input: {
  projects: readonly ProjectCodeRow[];
  repoOrigin: string;
  /** ラベルを付けた GitHub login。 */
  actor: string;
  /** 起票した GitHub login。 actor と別人のことがある。 */
  issueAuthor: string;
  trustedActors: readonly string[];
}): AuthorizationVerdict {
  const project = findProjectByRepository(input.projects, input.repoOrigin);
  if (!project) {
    return {
      kind: "reject",
      reason: "project_unregistered",
      detail: `${input.repoOrigin} は Cc の project registry に無い`,
    };
  }
  if (project.github_issue_workflow !== 1) {
    return {
      kind: "reject",
      reason: "project_opted_out",
      detail: `${project.code} は GitHub Issue ワークフローが OFF`,
    };
  }
  // 妥当性は「起票者」か「ラベルを付けた人」のどちらかが信頼実行者であること。
  // 空リストは「全員許可」ではなく「全件が承認待ち」。 設定漏れが黙って無確認の実行に
  // 化けない側へ倒す。
  const trusted = input.trustedActors.map((login) => login.trim().toLowerCase());
  const known = [input.issueAuthor, input.actor]
    .map((login) => (login ?? "").trim().toLowerCase())
    .filter((login) => login !== "");
  if (!known.some((login) => trusted.includes(login))) {
    return {
      kind: "needs_approval",
      project,
      detail: `起票 @${input.issueAuthor} / ラベル @${input.actor} はどちらも信頼実行者ではない`,
    };
  }
  return { kind: "allow", project };
}
