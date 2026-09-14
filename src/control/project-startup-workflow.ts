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
  // Absence is authoritative only after a successful, validated registry read.
  // A GitHub repository does not need Revisor registration or a GitHub App to push.
  const githubRemote = /^(?:https?:\/\/github\.com\/|git@github\.com:)[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(repoOrigin ?? "")
    || /^[\w.-]+\/[\w.-]+$/.test(repoOrigin ?? "");
  if (matches.length === 0 && githubRemote) return "github";
  // Omitted workflow has the same legacy default as the Cc project admin UI.
  return matches.length === 1 ? matches[0].workflow ?? "revisor" : "unknown";
}
