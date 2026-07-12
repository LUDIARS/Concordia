export interface ProjectCategory {
  name: string;
  entries: Array<[code: string, project: string]>;
}

export function projectCodeFor(
  repoPath: string | null | undefined,
  categories: readonly ProjectCategory[],
): string | null {
  const repo = repoBasename(repoPath);
  if (!repo) return null;
  for (const category of categories) {
    const entry = category.entries.find(([, project]) => project === repo);
    if (entry) return entry[0].split("/")[0];
  }
  return null;
}

export function repoBasename(repoPath: string | null | undefined): string {
  if (!repoPath) return "";
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}
