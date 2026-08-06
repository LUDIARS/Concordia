import {
  createProjectResolver,
  type ProjectTarget,
} from "../projects/project-resolver.js";

export type ForumProjectTarget = ProjectTarget;

export interface ForumProjectResolver {
  codeForRepo: (repoPath: string) => string;
  codesForRepos: (repoPaths: string[]) => string[];
  targetFromPost: (title: string, body: string) => ForumProjectTarget | null;
}

/** Canonical PROJECT-CODES.md を一度だけ読み、repo path から forum title 用コードを返す。 */
export function createForumProjectCodeResolver(
  workspaceRoots: readonly string[],
  log: { warn: (message: string) => void },
): (repoPath: string) => string {
  return createForumProjectResolver(workspaceRoots, log).codeForRepo;
}

export function createForumProjectResolver(
  workspaceRoots: readonly string[],
  log: { warn: (message: string) => void },
): ForumProjectResolver {
  const resolver = createProjectResolver(workspaceRoots, {
    warn: (message) => log.warn(`forum ${message}`),
  });
  return {
    codeForRepo: resolver.codeForRepo,
    codesForRepos: resolver.codesForRepos,
    targetFromPost: resolver.targetFromText,
  };
}
