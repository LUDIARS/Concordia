/** @implements spec/feature/shared-startup-context.md — project workflow selection */
import type { RevisorRepositoryRecord } from "../pr/revisor-repository-client.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";

export type ProjectStartupWorkflow = "revisor" | "github" | "unknown";

/** Use registration identity, never a global Cc flag or a worktree-name guess. */
export function selectProjectStartupWorkflow(
  records: readonly RevisorRepositoryRecord[], repoPath: string, repoOrigin: string | null,
): ProjectStartupWorkflow {
  const origin = normalizeRepoOrigin(repoOrigin ?? "").toLowerCase();
  const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const matches = records.filter((record) => origin
    ? normalizeRepoOrigin(record.repository).toLowerCase() === origin
    : normalizePath(record.rootPath) === normalizePath(repoPath));
  // Omitted workflow has the same legacy default as the Cc project admin UI.
  return matches.length === 1 ? matches[0].workflow ?? "revisor" : "unknown";
}

export function renderProjectStartupWorkflow(workflow: ProjectStartupWorkflow): string {
  switch (workflow) {
    case "revisor":
      return "- Cc 判定: Revisor Workflow。既定の完了範囲はローカル commit と Cc 経由の Revisor local PR 提出までです。session 自身は push・GitHub PR 作成をしないでください。PR 作成後は停止してください。";
    case "github":
      return "- Cc 判定: GitHub Workflow。既定の完了範囲は commit・作業 branch の push・GitHub PR 作成までです。PR 作成後は停止してください。";
    default:
      return "- Cc 判定: プロジェクトの workflow は未判定です。提出・push の前に Cc の対象プロジェクト設定を確認し、workflow を推測しないでください。PR 作成後は停止してください。";
  }
}
