// @spec 最後に登録した作業プロジェクト
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";

const pathKey = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The latest registered work target is authoritative; an unknown target must not select the startup repository. */
export function selectStartupPolicyProject(
  rows: readonly ProjectCodeRow[],
  session: { target_project?: string | null; repo_path: string; repo_origin: string | null },
): ProjectCodeRow | null {
  const target = session.target_project?.trim();
  if (target) {
    return rows.find((row) => row.code === target)
      ?? rows.find((row) => pathKey(row.repo_path) === pathKey(target))
      ?? rows.find((row) => row.project.toLowerCase() === target.toLowerCase())
      ?? null;
  }
  const origin = normalizeRepoOrigin(session.repo_origin ?? "").toLowerCase();
  return (origin ? rows.find((row) => normalizeRepoOrigin(row.repo_origin ?? "").toLowerCase() === origin) : null)
    ?? rows.find((row) => pathKey(row.repo_path) === pathKey(session.repo_path))
    ?? null;
}
