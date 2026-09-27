import { repositoryKey, type ActioBinding } from "./actio-binding.js";

export type ActioBindingScope = { project: string } | { repoPath: string };
export type ActioBindingReader = (scope?: ActioBindingScope) =>
  readonly ActioBinding[] | Promise<readonly ActioBinding[]>;

/** Select candidates without changing ownership or resolving an ambiguous team. */
export function matchesActioBindingScope(
  binding: Pick<ActioBinding, "project" | "repoPath">,
  scope?: ActioBindingScope,
): boolean {
  if (!scope) return true;
  return "repoPath" in scope
    ? repositoryKey(binding.repoPath) === repositoryKey(scope.repoPath)
    : binding.project.toLowerCase() === scope.project.toLowerCase();
}
