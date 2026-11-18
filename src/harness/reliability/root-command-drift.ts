/**
 * TB-ROOT-DRIFT: TB-ROOT-CMD で止めずに通した「作業境界のずれ」をセッション metadata に記録し、管制が読めるようにする。
 * 記録はセッションごとに 1 件の上書き (回数・最後の checkout・最後の rule)。履歴は持たない。
 *
 * @implements spec/feature/task-branch-harness.md TB-ROOT-DRIFT
 */
export const ROOT_COMMAND_DRIFT_KEY = "root_command_drift";

export interface RootCommandDrift {
  count: number;
  last_at: number;
  last_repo: string;
  last_branch: string | null;
  last_rules: string[];
}

export function readRootCommandDrift(metadata: string | null): RootCommandDrift | null {
  try {
    const raw = (JSON.parse(metadata || "{}") as Record<string, unknown>)[ROOT_COMMAND_DRIFT_KEY];
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.count !== "number" || typeof row.last_at !== "number" || typeof row.last_repo !== "string") return null;
    return {
      count: row.count, last_at: row.last_at, last_repo: row.last_repo,
      last_branch: typeof row.last_branch === "string" ? row.last_branch : null,
      last_rules: Array.isArray(row.last_rules) ? row.last_rules.filter((rule): rule is string => typeof rule === "string") : [],
    };
  } catch {
    return null;
  }
}

export function nextRootCommandDrift(previous: RootCommandDrift | null,
  input: { repo: string; branch?: string | null; rules: readonly string[] }, nowSec: number): RootCommandDrift {
  return { count: (previous?.count ?? 0) + 1, last_at: nowSec, last_repo: input.repo,
    last_branch: input.branch ?? null, last_rules: [...new Set(input.rules)] };
}

/** 管制の分類理由に添える 1 句。記録が無ければ null。 */
export function describeRootCommandDrift(drift: RootCommandDrift | null): string | null {
  if (!drift) return null;
  const leaf = drift.last_repo.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || drift.last_repo;
  return `作業場所のずれ ${drift.count} 回 (最終 ${leaf}${drift.last_branch ? `@${drift.last_branch}` : ""}: ${drift.last_rules.join(",")})`;
}
