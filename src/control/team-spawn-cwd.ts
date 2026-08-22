import { access } from "node:fs/promises";
import { resolve } from "node:path";

export type TeamSpawnCwdResult =
  | { ok: true; cwd: string }
  | { ok: false; error: string };

/**
 * Resolve the implicit cwd for a team-scoped spawn.
 *
 * A team may own multiple repositories, but the schema has no primary-repository marker.
 * Selecting an arbitrary entry would launch the session in the wrong project, so implicit
 * resolution is intentionally limited to teams with exactly one registered repository.
 */
export async function resolveTeamSpawnCwd(input: {
  teamName: string;
  repoOrigins: readonly string[];
  workspaceRoots: readonly string[];
}): Promise<TeamSpawnCwdResult> {
  if (input.repoOrigins.length !== 1) {
    return {
      ok: false,
      error: input.repoOrigins.length === 0
        ? `team ${input.teamName} has no repository; specify project or cwd`
        : `team ${input.teamName} has multiple repositories; specify project or cwd`,
    };
  }

  const repoName = repositoryName(input.repoOrigins[0]!);
  if (!repoName) {
    return { ok: false, error: `team ${input.teamName} has an invalid repository origin` };
  }
  for (const root of input.workspaceRoots) {
    const candidate = resolve(root, repoName);
    if (await access(candidate).then(() => true, () => false)) {
      return { ok: true, cwd: candidate };
    }
  }
  return {
    ok: false,
    error: `team ${input.teamName} repository is not available under workspace roots: ${repoName}`,
  };
}

function repositoryName(origin: string): string | null {
  const normalized = origin.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = normalized.split("/").pop()?.replace(/\.git$/i, "") ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(leaf) ? leaf : null;
}
