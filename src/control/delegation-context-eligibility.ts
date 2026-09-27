import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { ContextLinks } from "./inject-context-links.js";
import { contextEvidenceKey, hasConfirmedContextPresence } from "./inject-context-presence.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";

export interface DelegationContextEligibilityDeps {
  sessions: Pick<SessionsRepo, "findSession">;
  projectCodes: Pick<ProjectCodesRepo, "list">;
  resolveLinks: (repoPath: string, repoOrigin: string | null) => Promise<ContextLinks>;
  repositoryIdentity?: (repoPath: string) => Promise<string>;
}

export interface VerifiedAnatomiaContext { projectId: string; baseUrl: string; isCurrent: () => boolean }

/** A delegation inherits scoped guidance only from its currently bound, human-led parent. */
export async function allowDelegationDomainPreamble(
  deps: DelegationContextEligibilityDeps, parentSessionId: string | null | undefined, targetRepo: string | null,
): Promise<VerifiedAnatomiaContext | null> {
  if (!parentSessionId || !targetRepo) return null;
  const before = deps.sessions.findSession(parentSessionId);
  if (!before || before.status !== "active") return null;
  const identity = deps.repositoryIdentity ?? mainRepositoryKey;
  const [parentRoot, targetRoot] = await Promise.all([
    identity(before.repo_path).catch(() => null), identity(targetRepo).catch(() => null),
  ]);
  if (!parentRoot || parentRoot !== targetRoot) return null;
  const candidates = deps.projectCodes.list().filter((project) => project.ddd_enabled === 1
    && hasConfirmedContextPresence(before, project.code));
  if (candidates.length !== 1) return null;
  const links = await deps.resolveLinks(before.repo_path, before.repo_origin).catch(() => null);
  if (!links?.anatomia || !links.anatomiaProjectId || !links.anatomiaBaseUrl) return null;
  const isCurrent = (): boolean => {
    const after = deps.sessions.findSession(parentSessionId);
    return Boolean(after && after.status === "active" && after.repo_path === before.repo_path
      && after.repo_origin === before.repo_origin && after.branch === before.branch
      && after.target_project === before.target_project
      && contextEvidenceKey(after.metadata) === contextEvidenceKey(before.metadata)
      && deps.projectCodes.list().some((project) => project.code === candidates[0]!.code && project.ddd_enabled === 1));
  };
  return isCurrent() ? { projectId: links.anatomiaProjectId, baseUrl: links.anatomiaBaseUrl, isCurrent } : null;
}
