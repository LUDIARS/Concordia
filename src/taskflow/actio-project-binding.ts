import { repositoryKey, type ActioBinding } from "./actio-binding.js";
import { LOCAL_ACTIO_ACCESS, type ActioProject } from "./actio-projects.js";

export interface RepositoryProject { code: string; project: string; repo_path: string }

/** Pure policy: explicit destinations win; registration is joined by exact project code. */
export function mergeActioProjectBindings(
  configured: readonly ActioBinding[], repositories: readonly RepositoryProject[], registered: readonly ActioProject[],
): ActioBinding[] {
  const result = [...configured];
  for (const repo of repositories) {
    if (configured.some(binding => binding.subsidiaryId === null
      && repositoryKey(binding.repoPath) === repositoryKey(repo.repo_path))) continue;
    const matches = registered.filter(project => project.code === repo.code);
    if (matches.length > 1) throw new Error("Actio project registration is ambiguous");
    // Local discovery never assigns team work to the personal local identity.
    if (matches.length === 0 || matches[0]!.teamIds.length > 0) continue;
    const binding: ActioBinding = {
      ...LOCAL_ACTIO_ACCESS, repoPath: repo.repo_path, project: repo.project, projectId: repo.code,
    };
    if (result.some(other => repositoryKey(other.repoPath) === repositoryKey(binding.repoPath)
      && other.subsidiaryId === null)) throw new Error("Actio project registration is ambiguous");
    if (result.some(other => other.projectId === binding.projectId && other.ownerId === binding.ownerId
      && other.teamId === binding.teamId)) throw new Error("Duplicate Actio project ownership binding");
    result.push(binding);
  }
  return result;
}

/** Read on demand: adding an Actio registration needs no Cc restart or second registry. */
export function createActioBindingReader(input: {
  configured: () => readonly ActioBinding[];
  repositories: () => readonly RepositoryProject[];
  registered: () => Promise<readonly ActioProject[]>;
}): () => Promise<readonly ActioBinding[]> {
  return async () => {
    const configured = input.configured();
    // An explicit bearer deployment must never turn into a local deployment.
    if (configured.length > 0 && !configured.some(binding => binding.authMode === "loopback")) return configured;
    return mergeActioProjectBindings(configured, input.repositories(), await input.registered());
  };
}
