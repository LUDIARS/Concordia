import { resolve } from "node:path";

/**
 * TB-MULTI: セッションが同時に扱う checkout の登録 (repo_path / branch に加えて持つ)。
 * repo_path / branch は従来どおり先頭の登録として残り、ここには `lictor cli task set --repo` で足した登録が入る。
 * プロンプトからの作業対象推定 (target_project) はこの一覧を消さない。
 */
export const WORKING_TARGETS_METADATA_KEY = "working_targets";

/** 1 セッションが持てる追加登録の上限。古いものから押し出す。 */
export const MAX_WORKING_TARGETS = 8;

export type WorkingTargetSource = "explicit" | "inferred";

export interface WorkingTarget {
  repo: string;
  branch: string;
  source: WorkingTargetSource;
  registered_at: number;
}

function sameRepoPath(a: string, b: string): boolean {
  const left = resolve(a), right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function parseTarget(value: unknown): WorkingTarget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.repo !== "string" || !row.repo || typeof row.branch !== "string" || !row.branch) return null;
  return { repo: resolve(row.repo), branch: row.branch,
    source: row.source === "inferred" ? "inferred" : "explicit",
    registered_at: typeof row.registered_at === "number" ? row.registered_at : 0 };
}

export function readWorkingTargets(metadata: string | null): WorkingTarget[] {
  try {
    const raw = (JSON.parse(metadata || "{}") as Record<string, unknown>)[WORKING_TARGETS_METADATA_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.map(parseTarget).filter((target): target is WorkingTarget => target !== null);
  } catch {
    return [];
  }
}

/**
 * 同じ repo の登録を置き換えて足す。推定 (inferred) は明示 (explicit) の登録を上書きしない。
 */
export function upsertWorkingTarget(list: readonly WorkingTarget[], next: WorkingTarget): WorkingTarget[] {
  const target = { ...next, repo: resolve(next.repo) };
  const existing = list.find(item => sameRepoPath(item.repo, target.repo));
  if (existing && existing.source === "explicit" && target.source === "inferred") return [...list];
  const rest = list.filter(item => !sameRepoPath(item.repo, target.repo));
  return [...rest, target].slice(-MAX_WORKING_TARGETS);
}

export function removeWorkingTarget(list: readonly WorkingTarget[], repo: string): WorkingTarget[] {
  return list.filter(item => !sameRepoPath(item.repo, repo));
}
