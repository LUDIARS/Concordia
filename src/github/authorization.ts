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
  | { ok: true; project: ProjectCodeRow }
  | { ok: false; reason: "project_unregistered" | "project_opted_out" | "actor_untrusted"; detail: string };

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
  actor: string;
  trustedActors: readonly string[];
}): AuthorizationVerdict {
  const project = findProjectByRepository(input.projects, input.repoOrigin);
  if (!project) {
    return {
      ok: false,
      reason: "project_unregistered",
      detail: `${input.repoOrigin} は Cc の project registry に無い`,
    };
  }
  if (project.github_issue_workflow !== 1) {
    return {
      ok: false,
      reason: "project_opted_out",
      detail: `${project.code} は GitHub Issue ワークフローが OFF`,
    };
  }
  // 空リストは「全員許可」ではなく「誰も許可されていない」。 設定漏れで外部の誰かが
  // 実装セッションを起こせる状態を作らない。
  const trusted = input.trustedActors.map((login) => login.trim().toLowerCase());
  if (!trusted.includes(input.actor.trim().toLowerCase())) {
    return {
      ok: false,
      reason: "actor_untrusted",
      detail: `${input.actor} は信頼実行者リストに無い`,
    };
  }
  return { ok: true, project };
}
