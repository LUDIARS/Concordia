import { repositoryKey, type ActioBinding } from "./actio-binding.js";
import { LOCAL_ACTIO_ACCESS, type ActioProject } from "./actio-projects.js";
import { matchesActioBindingScope, type ActioBindingScope } from "./actio-binding-scope.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:06867ed4 */
import augurContract_d3322aca from './actio-project-binding.contract.js'; /* augur-inject:contract-predicate:0bf5f3a9 */

export interface RepositoryProject { code: string; project: string; repo_path: string }

/** Pure policy: explicit destinations win; registration is joined by exact project code. */
export function mergeActioProjectBindings(
  configured: readonly ActioBinding[], repositories: readonly RepositoryProject[], registered: readonly ActioProject[],
  scope?: ActioBindingScope,
): ActioBinding[] {
  const result = configured.filter(binding => matchesActioBindingScope(binding, scope));
  for (const repo of repositories) {
    if (!matchesActioBindingScope({ project: repo.project, repoPath: repo.repo_path }, scope)) continue;
    // Check all explicit bindings: a different configured label must not reopen discovery.
    if (configured.some(binding => binding.subsidiaryId === null
      && repositoryKey(binding.repoPath) === repositoryKey(repo.repo_path))) continue;
    const matches = registered.filter(project => project.code === repo.code);
    if (matches.length > 1) throw new Error("Actio project registration is ambiguous");
    if (matches.length === 0) continue;
    // Preserve the registered team; never choose arbitrarily or drop team scope.
    // Several teams are legitimate: stay team-less and keep the candidates so only
    // an explicitly requested registered team can be used (selectActioTeam).
    const teamIds = matches[0]!.teamIds;
    const binding: ActioBinding = {
      ...LOCAL_ACTIO_ACCESS, repoPath: repo.repo_path, project: repo.project, projectId: repo.code,
      teamId: teamIds.length === 1 ? teamIds[0]! : null,
      ...(teamIds.length > 1 ? { teamCandidates: [...teamIds] } : {}),
    };
    if (result.some(other => repositoryKey(other.repoPath) === repositoryKey(binding.repoPath)
      && other.subsidiaryId === null)) throw new Error("Actio project registration is ambiguous");
    if (result.some(other => other.projectId === binding.projectId && other.ownerId === binding.ownerId
      && other.teamId === binding.teamId)) throw new Error("Duplicate Actio project ownership binding");
    result.push(binding);
  }
  return result;
}
// @ts-expect-error augur-inject
mergeActioProjectBindings = contract(mergeActioProjectBindings, { ...augurContract_d3322aca, contractId: 'actio-team-C-5', mode: 'observe', sample: 1, where: 'src/taskflow/actio-project-binding.ts:8', rule: 'contract-wrap', id: 'd3322aca' }); /* augur-inject:contract-wrap:d3322aca */

/** Read on demand: adding an Actio registration needs no Cc restart or second registry. */
export function createActioBindingReader(input: {
  configured: () => readonly ActioBinding[];
  repositories: () => readonly RepositoryProject[];
  registered: () => Promise<readonly ActioProject[]>;
}): (scope?: ActioBindingScope) => Promise<readonly ActioBinding[]> {
  return async (scope) => {
    const configured = input.configured();
    // An explicit bearer deployment must never turn into a local deployment.
    if (configured.length > 0 && !configured.some(binding => binding.authMode === "loopback")) {
      return configured.filter(binding => matchesActioBindingScope(binding, scope));
    }
    return mergeActioProjectBindings(configured, input.repositories(), await input.registered(), scope);
  };
}
