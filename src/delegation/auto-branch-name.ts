/**
 * 委託 worktree のブランチ名を Concordia が自動で決める (Actio 31556a85)。
 *
 * 呼び出し側が worktree を明示的に有効にしたのに branch を契約にも引数にも渡さなかった
 * 場合、 以前は parseSpawnWorktree が false に倒れて共有 checkout で起動していた。
 * 人間の仕様判断 (2026-11-19 「明示優先 + ブランチ名は自動で付ける」) に従い、
 * run id から一意な名前を作って task worktree を用意する。 名前は run id で一意なので、
 * 既存ブランチと衝突した場合は連番で逃げずに起動を止める (service / prepareSpawnTarget)。
 *
 * すべて純関数。
 */

export const AUTO_BRANCH_PREFIX = "delegation/";
const SLUG_MAX = 40;
const RUN_ID_PREFIX_LENGTH = 8;

/** worktree の指定が「明示的に有効」か。 未指定 (undefined / null / 空) は false。 */
export function isExplicitWorktreeOn(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on", "worktree"].includes(value.trim().toLowerCase());
  }
  return false;
}

/** `delegation/<call_name の slug (最大 40 文字)>-<run id 先頭 8 文字>`。 */
export function autoDelegationBranchName(callName: string, runId: string): string {
  const slug = callName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "")
    .slice(0, SLUG_MAX).replace(/-+$/, "") || "run";
  return `${AUTO_BRANCH_PREFIX}${slug}-${runIdPrefix(runId)}`;
}

/** run の spawn_branch が、 この run のために自動で付けた名前か。 */
export function isAutoDelegationBranch(branch: string | null | undefined, runId: string): boolean {
  if (!branch || !branch.startsWith(AUTO_BRANCH_PREFIX)) return false;
  return branch.endsWith(`-${runIdPrefix(runId)}`);
}

/** run の branch がどこから来たか。 列を増やさず spawn_branch と run id から導出する。 */
export function delegationBranchSource(branch: string | null | undefined, runId: string): "auto" | "requested" | null {
  if (!branch) return null;
  return isAutoDelegationBranch(branch, runId) ? "auto" : "requested";
}

function runIdPrefix(runId: string): string {
  return runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, RUN_ID_PREFIX_LENGTH) || "run";
}
