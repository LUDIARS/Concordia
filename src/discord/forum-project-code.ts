import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { createProjectResolver, type ProjectTarget } from "../projects/project-resolver.js";

export type ForumProjectTarget = ProjectTarget;

export interface ForumProjectResolver {
  codeForRepo: (repoPath: string) => string;
  codesForRepos: (repoPaths: string[]) => string[];
  targetFromPost: (title: string, body: string) => ForumProjectTarget | null;
}

/** Registry を操作ごとに読み、command 登録を再起動なしで forum routing へ反映する。 */
export function createForumProjectResolver(
  listRows: () => readonly ProjectCodeRow[],
): ForumProjectResolver {
  const current = () => createProjectResolver(listRows());
  return {
    codeForRepo: (repoPath) => current().codeForRepo(repoPath),
    codesForRepos: (repoPaths) => current().codesForRepos(repoPaths),
    targetFromPost: (title, body) => current().targetFromText(title, body),
  };
}
